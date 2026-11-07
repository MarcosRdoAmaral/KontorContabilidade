// ---------------------------------------------------------------------------
// Núcleo da conexão Kontor Contabilidade ⇄ Kontor Empresas (arquivo igual nos dois sistemas).
// A API (kontorgestao.com.br/api/conexao/v1) só repassa mensagens; aqui elas são cifradas e decifradas:
// - cada lado tem um par de chaves X25519 (a privada fica cifrada no banco local, pelo cofre);
// - a chave de cada conexão sai do acordo X25519 + HKDF-SHA256, com os dois CNPJs como contexto;
// - o conteúdo vai em JSON compactado (gzip), cifrado com AES-256-GCM (o tipo da mensagem entra como dado autenticado);
// - envios grandes vão em partes, remontadas aqui antes de decifrar.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { db } from '../db.js';
import { ErroNegocio } from '../servicos/emissao.js';

export const URL_PADRAO = 'https://kontorgestao.com.br/api/conexao/v1';
export const urlApi = () => (process.env.KONTOR_CONEXAO_URL || URL_PADRAO).replace(/\/+$/, '');
const TAM_PARTE = 1_400_000;
const VERSAO = 1;

/** Erro devolvido pela API, com o código HTTP (410 = conexão desfeita, 0 = sem internet). */
export class FalhaApi extends ErroNegocio {
  constructor(public http: number, mensagem: string) { super(mensagem, http >= 400 && http < 500 ? 422 : 502); }
}

export async function chamarApi<T = any>(metodo: string, rota: string, corpo?: unknown, token?: string): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(urlApi() + rota, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new FalhaApi(0, 'Sem conexão com o serviço Kontor. Confira a internet e tente de novo.');
  }
  let d: any = null;
  try { d = await r.json(); } catch { /* resposta sem JSON */ }
  if (!r.ok || !d?.ok) throw new FalhaApi(r.status, d?.erro ?? `O serviço Kontor respondeu com erro (HTTP ${r.status}).`);
  return d as T;
}

// ---- criptografia ----

/** Novo par de chaves: a pública (32 bytes, base64url) vai para a API; a privada (PKCS#8, base64) fica cifrada no banco. */
export function gerarChaves(): { publica: string; privada: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publica: (publicKey.export({ format: 'jwk' }) as { x: string }).x, privada: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

/** Chave simétrica da conexão: os dois lados chegam à mesma chave, cada um com a sua privada e a pública do outro. */
export function chaveSessao(privada: string, publicaOutro: string, cnpjEscritorio: string, cnpjCliente: string): Buffer {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privada, 'base64'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicaOutro }, format: 'jwk' });
  const segredo = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(crypto.hkdfSync('sha256', segredo, 'kontor-conexao-v1', `${cnpjEscritorio}|${cnpjCliente}`, 32));
}

/** Código curto da chave da conexão, igual nos dois lados (para conferir por telefone, se quiser). */
export const impressao = (chave: Buffer) => crypto.createHash('sha256').update(chave).digest('hex').slice(0, 8).toUpperCase().replace(/(.{4})/, '$1-');

export function selar(chave: Buffer, tipo: string, dados: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  c.setAAD(Buffer.from(`${VERSAO}|${tipo}`));
  const corpo = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(dados)))), c.final()]);
  return Buffer.concat([Buffer.from([VERSAO]), iv, c.getAuthTag(), corpo]).toString('base64url');
}

export function abrir(chave: Buffer, tipo: string, texto: string): any {
  const b = Buffer.from(texto, 'base64url');
  if (b.length < 30 || b[0] !== VERSAO) throw new Error('Formato de mensagem desconhecido.');
  const d = crypto.createDecipheriv('aes-256-gcm', chave, b.subarray(1, 13));
  d.setAAD(Buffer.from(`${VERSAO}|${tipo}`));
  d.setAuthTag(b.subarray(13, 29));
  const claro = Buffer.concat([d.update(b.subarray(29)), d.final()]);
  return JSON.parse(zlib.gunzipSync(claro).toString('utf8'));
}

// ---- envio e recebimento ----

/** Cifra e envia; envios grandes vão em partes. Devolve o identificador do envio. */
export async function enviarEnvelope(token: string, chave: Buffer, tipo: string, dados: unknown, vinculo?: number): Promise<string> {
  const selado = selar(chave, tipo, dados);
  const grupo = crypto.randomUUID();
  const total = Math.max(1, Math.ceil(selado.length / TAM_PARTE));
  for (let i = 0; i < total; i++) {
    const corpo = { tipo, grupo, parte: i + 1, total, corpo: selado.slice(i * TAM_PARTE, (i + 1) * TAM_PARTE), ...(vinculo ? { vinculo } : {}) };
    let tentativa = 0;
    for (;;) {
      try { await chamarApi('POST', '/mensagens', corpo, token); break; } catch (e) {
        // falha de rede: tenta de novo a mesma parte (a API ignora parte repetida)
        if (!(e instanceof FalhaApi) || e.http !== 0 || ++tentativa >= 3) throw e;
      }
    }
  }
  return grupo;
}

export interface Envelope { vinculo: number; tipo: string; grupo: string; dados: any; recebido_em: string }

/**
 * Busca o que chegou, guarda as partes no banco local, confirma o recebimento na API (que então apaga)
 * e entrega cada envio completo a `tratar`. Envio que falhar em `tratar` fica guardado e é tentado de novo.
 */
export async function buscarEnvelopes(token: string, chaveDe: (vinculo: number) => Buffer | null, tratar: (e: Envelope) => void | Promise<void>) {
  for (let volta = 0; volta < 25; volta++) {
    const r = await chamarApi<{ mensagens: { id: number; vinculo: number; tipo: string; grupo: string; parte: number; total: number; corpo: string; criado_em: string }[]; restantes: number }>('GET', '/mensagens', undefined, token);
    if (!r.mensagens.length) break;
    const ins = db.prepare('INSERT OR IGNORE INTO conexao_partes (grupo, parte, total, tipo, vinculo, corpo, criado_em) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => { for (const m of r.mensagens) ins.run(m.grupo, m.parte, m.total, m.tipo, m.vinculo, m.corpo, m.criado_em); })();
    await chamarApi('POST', '/mensagens/confirmar', { ids: r.mensagens.map((m) => m.id) }, token);
    if (!r.restantes) break;
  }
  const completos = db.prepare(`SELECT grupo, MAX(tipo) AS tipo, MAX(vinculo) AS vinculo, MAX(total) AS total, MIN(criado_em) AS criado_em
    FROM conexao_partes GROUP BY grupo HAVING COUNT(*) = MAX(total) ORDER BY MIN(criado_em), grupo`).all() as { grupo: string; tipo: string; vinculo: number; criado_em: string }[];
  let recebidos = 0;
  const erros: string[] = [];
  for (const g of completos) {
    const partes = db.prepare('SELECT corpo FROM conexao_partes WHERE grupo = ? ORDER BY parte').all(g.grupo) as { corpo: string }[];
    const apagar = () => db.prepare('DELETE FROM conexao_partes WHERE grupo = ?').run(g.grupo);
    const chave = chaveDe(g.vinculo);
    if (!chave) { apagar(); erros.push(`Mensagem de uma conexão que não existe mais neste computador (${g.tipo}).`); continue; }
    let dados: any;
    try { dados = abrir(chave, g.tipo, partes.map((p) => p.corpo).join('')); } catch {
      apagar(); erros.push(`Uma mensagem (${g.tipo}) não pôde ser decifrada e foi descartada. Se continuar, refaça a conexão.`); continue;
    }
    try {
      await tratar({ vinculo: g.vinculo, tipo: g.tipo, grupo: g.grupo, dados, recebido_em: g.criado_em });
      apagar(); recebidos++;
    } catch (e) {
      erros.push(e instanceof Error ? e.message : String(e));
    }
  }
  // partes órfãs (envio interrompido) somem depois de 30 dias
  db.prepare("DELETE FROM conexao_partes WHERE criado_em < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')").run();
  return { recebidos, erros };
}
