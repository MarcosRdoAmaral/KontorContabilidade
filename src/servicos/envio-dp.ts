import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { enviarComModelo } from './email.js';
import { camposCliente, camposMes, type Variaveis } from './modelos-email.js';
import { lerGuia } from './fechamento.js';
import { lancarNoControle } from './controle-mensal.js';
import { norm, porNome } from './importar-controle.js';

/**
 * Envio automático dos documentos do departamento pessoal. O escritório guarda os arquivos em
 *   <pasta>\<Cliente>\<AAAA>\<MM-AAAA>\  (Recibo Mensal, Darf Previdenciária, FGTS, Boleto Sindicato)
 * e o Kontor, de tempos em tempos, olha a pasta: quando o conjunto esperado do mês de um cliente está completo, manda
 * um e-mail só com tudo; arquivo que chega (ou muda) depois vai num e-mail de complemento. Cada envio fica registrado,
 * os valores das guias vão para o Controle mensal e a data de envio é marcada.
 */

export const TIPOS_DP = { DARF: 'DARF previdenciária', FGTS: 'Guia do FGTS', SINDICATO: 'Boleto do sindicato', RECIBO: 'Recibo mensal (pró-labore)', FOLHA: 'Espelho e resumo da folha', RECIBO_DCTF: 'Recibo da DCTFWeb' } as const;
export type TipoDp = keyof typeof TIPOS_DP;
const ORDEM = Object.keys(TIPOS_DP) as TipoDp[];

export const ConfigDp = z.object({
  ligado: z.boolean(),
  pasta: z.string().trim().max(400),
  desde: z.string().regex(/^\d{4}-\d{2}$/, 'Informe a competência inicial'),
});
export type ConfigDp = z.infer<typeof ConfigDp>;
const chave = (escritorioId: number) => `envio_dp:${escritorioId}`;
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const mesAtual = () => hoje().slice(0, 7);
const proximoMes = (m: string) => { const [a, mm] = m.split('-').map(Number); return new Date(Date.UTC(a, mm, 1)).toISOString().slice(0, 7); };
const rotulo = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
/** Arquivo modificado há menos que isto ainda pode estar sendo gravado/copiado: espera a próxima volta. */
const ESPERA_MS = 2 * 60e3;

export function lerConfigDp(escritorioId: number): ConfigDp {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(chave(escritorioId)) as any)?.valor;
  const padrao = { ligado: false, pasta: '', desde: mesAtual() };
  try { return v ? { ...padrao, ...JSON.parse(v) } : padrao; } catch { return padrao; }
}
export function salvarConfigDp(escritorioId: number, d: ConfigDp) {
  if (d.ligado) {
    if (!d.pasta) throw new ErroNegocio('Informe a pasta do departamento pessoal.');
    if (!fs.existsSync(d.pasta) || !fs.statSync(d.pasta).isDirectory()) throw new ErroNegocio(`A pasta "${d.pasta}" não foi encontrada neste computador.`);
  }
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(chave(escritorioId), JSON.stringify(d));
  return { ok: true };
}

/** Tipo do documento pelo nome do arquivo (os nomes do sistema da folha são fixos). */
export function tipoDoArquivo(nome: string): TipoDp | null {
  if (!/\.pdf$/i.test(nome)) return null;
  // sem acentos, espaços e pontuação: "Recibo Dctf Web.pdf" -> "recibodctfwebpdf"
  const n = nome.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/recibo.*dctf|dctf.*recibo/.test(n)) return 'RECIBO_DCTF';
  if (/recibomensal|prolabore/.test(n)) return 'RECIBO';
  if (/espelho|resumodafolha|folhadepagamento/.test(n)) return 'FOLHA';
  if (/darf/.test(n)) return 'DARF';
  if (/fgts/.test(n)) return 'FGTS';
  if (/sindica/.test(n)) return 'SINDICATO';
  return null;
}

export function docsEsperados(e: { dp_docs?: string | null; tem_funcionarios?: number | boolean }): TipoDp[] {
  try { const l = e.dp_docs ? (JSON.parse(e.dp_docs) as TipoDp[]).filter((t) => t in TIPOS_DP) : null; if (l?.length) return l; } catch { /* padrão */ }
  return e.tem_funcionarios ? ['DARF', 'FGTS', 'RECIBO'] : ['DARF', 'RECIBO'];
}

export const ClienteDp = z.object({
  dp_pasta: z.string().trim().max(200).nullish(),
  dp_docs: z.array(z.enum(['DARF', 'FGTS', 'SINDICATO', 'RECIBO', 'FOLHA', 'RECIBO_DCTF'])).min(1, 'Marque ao menos um documento').nullish(),
  dp_envio_auto: z.boolean().optional(),
});
export function salvarClienteDp(escritorioId: number, empresaId: number, d: z.infer<typeof ClienteDp>) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (d.dp_pasta !== undefined) db.prepare('UPDATE empresas SET dp_pasta = ? WHERE id = ?').run(d.dp_pasta || null, empresaId);
  if (d.dp_docs !== undefined) db.prepare('UPDATE empresas SET dp_docs = ? WHERE id = ?').run(d.dp_docs ? JSON.stringify(d.dp_docs) : null, empresaId);
  if (d.dp_envio_auto !== undefined) db.prepare('UPDATE empresas SET dp_envio_auto = ? WHERE id = ?').run(d.dp_envio_auto ? 1 : 0, empresaId);
  return { ok: true };
}

const subpastas = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

/** Pastas de cliente na pasta do DP, ligadas aos clientes da carteira (pelo nome guardado ou pelo nome da empresa). */
export function pastasDosClientes(escritorioId: number, cfg = lerConfigDp(escritorioId)) {
  const emp = db.prepare(`SELECT id, razao_social, nome_fantasia, dp_pasta FROM empresas WHERE escritorio_id = ? AND na_carteira = 1 AND eh_escritorio = 0 AND situacao = 'ATIVO'`).all(escritorioId) as any[];
  const clientes = emp.map((e) => ({ id: e.id, nomes: [norm(e.razao_social ?? ''), norm(e.nome_fantasia ?? '')].filter(Boolean) }));
  return subpastas(cfg.pasta).sort((a, b) => a.localeCompare(b, 'pt-BR')).map((pasta) => {
    const fixo = emp.find((e) => e.dp_pasta && norm(e.dp_pasta) === norm(pasta));
    return { pasta, empresa_id: fixo?.id ?? porNome(clientes, pasta), por: fixo ? 'escolhida' : 'nome' };
  });
}

interface ArqDp { id: number; tipo: TipoDp; caminho: string; valor: number | null; vencimento: string | null; envio_id: number | null }

/** Registra os arquivos de uma pasta de competência (versões novas viram registros novos). */
async function registrar(empresaId: number, comp: string, dir: string) {
  let nomes: string[] = [];
  try { nomes = fs.readdirSync(dir); } catch { return; }
  const ins = db.prepare('INSERT OR IGNORE INTO dp_arquivos (empresa_id, competencia, tipo, caminho, tamanho, modificado, valor, vencimento) VALUES (?,?,?,?,?,?,?,?)');
  for (const nome of nomes) {
    const tipo = tipoDoArquivo(nome);
    if (!tipo) continue;
    const caminho = path.join(dir, nome);
    let st: fs.Stats;
    try { st = fs.statSync(caminho); } catch { continue; }
    if (!st.isFile() || !st.size || Date.now() - st.mtimeMs < ESPERA_MS) continue;
    const mod = new Date(Math.floor(st.mtimeMs)).toISOString();
    if (db.prepare('SELECT 1 FROM dp_arquivos WHERE caminho = ? AND tamanho = ? AND modificado = ?').get(caminho, st.size, mod)) continue;
    const lida = !['DARF', 'FGTS', 'SINDICATO'].includes(tipo) ? { valor: null, vencimento: null } : await lerGuia(fs.readFileSync(caminho)).catch(() => ({ valor: null, vencimento: null }));
    ins.run(empresaId, comp, tipo, caminho, st.size, mod, lida.valor, lida.vencimento);
  }
}

/** A versão mais recente de cada tipo que ainda existe na pasta. */
function atuais(empresaId: number, comp: string): ArqDp[] {
  const l = db.prepare(`SELECT id, tipo, caminho, valor, vencimento, envio_id FROM dp_arquivos WHERE id IN (SELECT MAX(id) FROM dp_arquivos WHERE empresa_id = ? AND competencia = ? GROUP BY tipo)`).all(empresaId, comp) as ArqDp[];
  return l.filter((a) => fs.existsSync(a.caminho)).sort((a, b) => ORDEM.indexOf(a.tipo) - ORDEM.indexOf(b.tipo));
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (d: string) => d.split('-').reverse().join('/');

export interface ResultadoDp { empresa_id: number; cliente: string; competencia: string; situacao: 'ENVIADO' | 'COMPLEMENTO' | 'AGUARDANDO' | 'JA_ENVIADO' | 'SEM_EMAIL' | 'ERRO' | 'DESLIGADO'; arquivos: TipoDp[]; faltando: TipoDp[]; mensagem?: string }

/**
 * Olha a pasta do DP. Com `enviar`, manda o que estiver pronto; sem ele, só mostra o que aconteceria.
 * Só competências a partir de `desde` (na configuração) e até o mês que vem entram.
 */
export async function varrerPastaDp(escritorioId: number, enviar: boolean): Promise<ResultadoDp[]> {
  const cfg = lerConfigDp(escritorioId);
  if (!cfg.pasta || !fs.existsSync(cfg.pasta)) return [];
  const limite = proximoMes(mesAtual());
  const res: ResultadoDp[] = [];
  for (const p of pastasDosClientes(escritorioId, cfg)) {
    if (!p.empresa_id) continue;
    const e = db.prepare('SELECT id, COALESCE(nome_fantasia, razao_social) AS cliente, email, tem_funcionarios, dp_docs, dp_envio_auto FROM empresas WHERE id = ?').get(p.empresa_id) as any;
    const raiz = path.join(cfg.pasta, p.pasta);
    for (const ano of subpastas(raiz).filter((a) => /^\d{4}$/.test(a) && a >= cfg.desde.slice(0, 4))) {
      for (const sub of subpastas(path.join(raiz, ano))) {
        const m = /^(\d{2})[-_.](\d{4})$/.exec(sub.trim());
        if (!m) continue;
        const comp = `${m[2]}-${m[1]}`;
        if (comp < cfg.desde || comp > limite) continue;
        await registrar(e.id, comp, path.join(raiz, ano, sub));
        const esperados = docsEsperados(e);
        const arqs = atuais(e.id, comp).filter((a) => esperados.includes(a.tipo)); // só os documentos escolhidos para o cliente
        if (!arqs.length) continue;
        const faltando = esperados.filter((t) => !arqs.some((a) => a.tipo === t));
        const novos = arqs.filter((a) => !a.envio_id);
        const jaEnviou = !!db.prepare("SELECT 1 FROM dp_envios WHERE empresa_id = ? AND competencia = ? AND situacao = 'ENVIADO'").get(e.id, comp);
        const base = { empresa_id: e.id, cliente: e.cliente, competencia: comp, arquivos: arqs.map((a) => a.tipo), faltando };
        if (!e.dp_envio_auto) { res.push({ ...base, situacao: 'DESLIGADO' }); continue; }
        if (!novos.length) { res.push({ ...base, situacao: 'JA_ENVIADO' }); continue; }
        if (!jaEnviou && faltando.length) { res.push({ ...base, situacao: 'AGUARDANDO' }); continue; }
        const emails = String(e.email ?? '').split(/[,;\s]+/).filter((x) => x.includes('@'));
        if (!emails.length) { res.push({ ...base, situacao: 'SEM_EMAIL', mensagem: 'Cliente sem e-mail no cadastro da Carteira.' }); continue; }
        if (!enviar) { res.push({ ...base, situacao: jaEnviou ? 'COMPLEMENTO' : 'ENVIADO', mensagem: 'pronto para enviar' }); continue; }
        const r = await enviarConjunto(escritorioId, e, comp, jaEnviou ? novos : arqs, jaEnviou, emails);
        res.push({ ...base, situacao: r.ok ? (jaEnviou ? 'COMPLEMENTO' : 'ENVIADO') : 'ERRO', mensagem: r.ok ? `enviado para ${emails.join(', ')}` : r.erro });
      }
    }
  }
  return res;
}

async function enviarConjunto(escritorioId: number, e: any, comp: string, arqs: ArqDp[], complemento: boolean, emails: string[]) {
  const vars: Variaveis = { ...camposCliente(e.id), ...camposMes(comp),
    documentos: arqs.map((a) => ({ rotulo: TIPOS_DP[a.tipo], valor: a.valor != null ? brl(a.valor) : null, detalhe: a.vencimento ? `Vencimento ${dataBr(a.vencimento)}` : null })) };
  try {
    const anexos = arqs.map((a) => ({ filename: path.basename(a.caminho), content: fs.readFileSync(a.caminho), contentType: 'application/pdf' }));
    const ok = await enviarComModelo(escritorioId, complemento ? 'dp_complemento' : 'dp', vars, emails, { anexos });
    if (!ok) throw new ErroNegocio('Configure o servidor de e-mail em Configurações > E-mail.');
  } catch (err: any) {
    const erro = String(err?.message ?? err);
    const ultimo = db.prepare('SELECT situacao, erro FROM dp_envios WHERE empresa_id = ? AND competencia = ? ORDER BY id DESC LIMIT 1').get(e.id, comp) as any;
    if (!(ultimo?.situacao === 'ERRO' && ultimo.erro === erro)) // não repete o mesmo erro a cada volta
      db.prepare("INSERT INTO dp_envios (empresa_id, competencia, situacao, destino, itens, complemento, erro) VALUES (?,?, 'ERRO',?,?,?,?)").run(e.id, comp, emails.join(', '), arqs.map((a) => a.tipo).join(','), complemento ? 1 : 0, erro);
    return { ok: false, erro };
  }
  db.transaction(() => {
    const envio = Number(db.prepare("INSERT INTO dp_envios (empresa_id, competencia, situacao, destino, itens, complemento) VALUES (?,?, 'ENVIADO',?,?,?)")
      .run(e.id, comp, emails.join(', '), arqs.map((a) => a.tipo).join(','), complemento ? 1 : 0).lastInsertRowid);
    const marca = db.prepare('UPDATE dp_arquivos SET envio_id = ? WHERE id = ?');
    for (const a of arqs) marca.run(envio, a.id);
    // valores das guias no Controle mensal (a guia manda) e a data do envio
    const campo: Partial<Record<TipoDp, string>> = { DARF: 'darf_prev', FGTS: 'fgts', SINDICATO: 'sindicato' };
    for (const a of arqs) if (campo[a.tipo]) lancarNoControle(e.id, comp, 'DP', campo[a.tipo]!, a.valor, null, true);
    const atual = db.prepare("SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = ? AND area = 'DP'").get(e.id, comp) as any;
    const d = atual ? JSON.parse(atual.dados_json) : {};
    if (!d.enviado) {
      d.enviado = hoje();
      db.prepare(`INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json) VALUES (?,?, 'DP', ?)
        ON CONFLICT(empresa_id, competencia, area) DO UPDATE SET dados_json = excluded.dados_json, atualizado_em = datetime('now')`).run(e.id, comp, JSON.stringify(d));
    }
  })();
  return { ok: true as const };
}

/** Tela de configuração: pastas encontradas, ligação com os clientes, documentos esperados e os últimos envios. */
export function painelDp(escritorioId: number) {
  const cfg = lerConfigDp(escritorioId);
  const existe = !!cfg.pasta && fs.existsSync(cfg.pasta);
  const pastas = existe ? pastasDosClientes(escritorioId, cfg) : [];
  const clientes = (db.prepare(`SELECT id, COALESCE(nome_fantasia, razao_social) AS cliente, email, tem_funcionarios, dp_docs, dp_envio_auto, dp_pasta FROM empresas
    WHERE escritorio_id = ? AND na_carteira = 1 AND eh_escritorio = 0 AND situacao = 'ATIVO' ORDER BY cliente`).all(escritorioId) as any[])
    .map((c) => ({ id: c.id, cliente: c.cliente, email: c.email, docs: docsEsperados(c), envio_auto: !!c.dp_envio_auto, dp_pasta: c.dp_pasta }));
  const envios = db.prepare(`SELECT v.*, COALESCE(e.nome_fantasia, e.razao_social) AS cliente FROM dp_envios v JOIN empresas e ON e.id = v.empresa_id
    WHERE e.escritorio_id = ? ORDER BY v.id DESC LIMIT 40`).all(escritorioId);
  return { config: cfg, pasta_existe: existe, pastas, clientes, envios, tipos: TIPOS_DP };
}

/** Volta automática (a cada poucos minutos, com o programa aberto). */
export async function envioDpAutomatico() {
  for (const { id } of db.prepare('SELECT id FROM escritorios').all() as { id: number }[]) {
    const cfg = lerConfigDp(id);
    if (!cfg.ligado || !cfg.pasta) continue;
    try { await varrerPastaDp(id, true); } catch (e) { console.error('Envio automático do DP:', e); }
  }
}
