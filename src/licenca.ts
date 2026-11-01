import crypto from 'node:crypto';
import { db } from './db.js';
import { CHAVE_PUBLICA } from './licenca-chave.js';
import { ErroNegocio } from './servicos/emissao.js';

export const DIAS_TESTE = 7;
export const AVISO_DIAS = 15;

export type Plano = 'teste' | 'bronze' | 'prata' | 'ouro' | 'diamante';
export interface DadosPlano { nome: string; empresas: number | null; clientes: number | null; preco: number | null; resumo: string }

/** Planos do Kontor Gestão Contabilidade. null = sem limite. O limite de clientes vale para a carteira. O Diamante é feito sob encomenda. */
export const PLANOS: Record<Plano, DadosPlano> = {
  teste: { nome: 'Teste', empresas: 1, clientes: 2, preco: 0, resumo: '7 dias, 1 empresa e 2 clientes' },
  bronze: { nome: 'Bronze', empresas: null, clientes: 30, preco: 350, resumo: 'Até 30 clientes na carteira' },
  prata: { nome: 'Prata', empresas: null, clientes: 100, preco: 600, resumo: 'Até 100 clientes na carteira' },
  ouro: { nome: 'Ouro', empresas: null, clientes: 300, preco: 1000, resumo: 'Até 300 clientes na carteira' },
  diamante: { nome: 'Diamante', empresas: null, clientes: null, preco: null, resumo: 'Quantidade ilimitada, sob encomenda' },
};
export const PLANOS_PAGOS: Plano[] = ['bronze', 'prata', 'ouro', 'diamante'];
export const SUPORTE_WHATSAPP = '5547999017034';

export type EstadoLicenca = 'livre' | 'teste' | 'ativa' | 'vencida' | 'relogio';

/** Ganchos para teste. */
export const _teste = { agora: () => new Date(), chave: () => process.env.LICENCA_CHAVE_PUBLICA ?? CHAVE_PUBLICA };

const hojeBr = () => new Date(_teste.agora().getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const b64u = (b: Buffer) => b.toString('base64url');

function linha() {
  db.prepare('INSERT OR IGNORE INTO licenca (id) VALUES (1)').run();
  return db.prepare('SELECT * FROM licenca WHERE id = 1').get() as any;
}

function idMaquina(): string {
  const env = process.env.NFSE_MACHINE_ID;
  if (env) return env;
  const l = linha();
  if (l.maquina_alt) return l.maquina_alt;
  const novo = crypto.randomUUID();
  db.prepare('UPDATE licenca SET maquina_alt = ? WHERE id = 1').run(novo);
  return novo;
}

/** Código que o cliente informa ao dono: 16 hex em grupos de 4. */
export function codigoDoComputador(): string {
  const h = crypto.createHash('sha256').update('kontor-contab|' + idMaquina()).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

const soHex = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

export interface DadosCodigo { maquina: string; ate: string; cliente: string; plano: Plano }

/** Confere a assinatura e devolve os dados, ou lança ErroNegocio. */
export function lerCodigo(codigo: string): DadosCodigo {
  const chave = _teste.chave();
  if (!chave) throw new ErroNegocio('Controle de licença ainda não configurado nesta versão.');
  const partes = codigo.trim().split('.');
  if (partes.length !== 3 || (partes[0] !== 'KG1' && partes[0] !== 'KG2')) throw new ErroNegocio('Código de ativação inválido.');
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: chave }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(partes[1], 'base64url'), pub, Buffer.from(partes[2], 'base64url'));
  } catch { ok = false; }
  if (!ok) throw new ErroNegocio('Código de ativação inválido.');
  const campos = Buffer.from(partes[1], 'base64url').toString('utf8').split('|');
  const [maquina, ate] = campos;
  if (!maquina || !/^\d{4}-\d{2}-\d{2}$/.test(ate ?? '')) throw new ErroNegocio('Código de ativação inválido.');
  // KG1 (anterior aos planos) segue sem limites; KG2 traz o plano antes do nome do cliente
  if (partes[0] === 'KG1') return { maquina, ate, cliente: campos.slice(2).join('|'), plano: 'diamante' };
  const plano = campos[2] as Plano;
  if (!PLANOS_PAGOS.includes(plano)) throw new ErroNegocio('Código de ativação inválido.');
  return { maquina, ate, cliente: campos.slice(3).join('|'), plano };
}

const dias = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / 86400e3);

export function statusLicenca() {
  const base = { codigoComputador: codigoDoComputador(), diasTeste: DIAS_TESTE, plano: 'teste' as Plano, planoNome: PLANOS.teste.nome, limites: { empresas: PLANOS.teste.empresas, clientes: PLANOS.teste.clientes } };
  if (!_teste.chave()) return { ...base, plano: 'diamante' as Plano, planoNome: 'Sem controle', limites: { empresas: null as number | null, clientes: null as number | null }, estado: 'livre' as EstadoLicenca, permitido: true, mensagem: 'Controle de licença desativado.' };

  const l = linha();
  const hoje = hojeBr();
  const agoraIso = _teste.agora().toISOString();
  // relógio voltado: data atual bem anterior à última vez que o sistema foi aberto
  const vistoDia = l.ultimo_visto ? l.ultimo_visto.slice(0, 10) : null;
  if (vistoDia && dias(hoje, vistoDia) > 1) {
    return { ...base, estado: 'relogio' as EstadoLicenca, permitido: false, mensagem: 'A data do computador está anterior à última utilização. Corrija a data do Windows para voltar a emitir.' };
  }
  if (!vistoDia || vistoDia < hoje) db.prepare('UPDATE licenca SET ultimo_visto = ? WHERE id = 1').run(agoraIso);

  if (l.codigo) {
    try {
      const d = lerCodigo(l.codigo);
      if (soHex(d.maquina) === soHex(base.codigoComputador)) {
        const resta = dias(hoje, d.ate);
        const pl = PLANOS[d.plano];
        const dp = { plano: d.plano, planoNome: pl.nome, limites: { empresas: pl.empresas, clientes: pl.clientes } };
        if (resta >= 0) {
          return { ...base, ...dp, estado: 'ativa' as EstadoLicenca, permitido: true, ate: d.ate, cliente: d.cliente, diasRestantes: resta,
            aviso: resta <= AVISO_DIAS, mensagem: `Licença válida até ${d.ate.split('-').reverse().join('/')}.` };
        }
        return { ...base, ...dp, estado: 'vencida' as EstadoLicenca, permitido: false, ate: d.ate, cliente: d.cliente, diasRestantes: resta,
          mensagem: `Licença vencida em ${d.ate.split('-').reverse().join('/')}. Use "Alterar plano" ou informe o código do computador ao suporte para renovar.` };
      }
    } catch { /* cai para o teste */ }
  }
  let inicio = l.inicio_teste as string | null;
  if (!inicio) { inicio = agoraIso; db.prepare('UPDATE licenca SET inicio_teste = ? WHERE id = 1').run(inicio); }
  const resta = DIAS_TESTE - dias(inicio.slice(0, 10), hoje);
  if (resta > 0) {
    return { ...base, estado: 'teste' as EstadoLicenca, permitido: true, diasRestantes: resta, aviso: resta <= AVISO_DIAS,
      mensagem: `Período de teste: ${resta} dia(s) restante(s).` };
  }
  return { ...base, estado: 'vencida' as EstadoLicenca, permitido: false, diasRestantes: 0,
    mensagem: 'O período de teste terminou. Informe o código do computador ao suporte para receber o código de ativação.' };
}

export function ativarLicenca(codigo: string) {
  const d = lerCodigo(codigo);
  if (soHex(d.maquina) !== soHex(codigoDoComputador())) throw new ErroNegocio('Este código foi gerado para outro computador.');
  if (dias(hojeBr(), d.ate) < 0) throw new ErroNegocio('Este código de ativação já está vencido.');
  linha();
  db.prepare("UPDATE licenca SET codigo = ?, cliente = ?, ate = ?, ativada_em = datetime('now') WHERE id = 1").run(codigo.trim(), d.cliente, d.ate);
  return statusLicenca();
}

/** Bloqueia apenas ações que emitem/alteram notas. Consultas, downloads e backup seguem liberados. */
export function exigirLicenca(): void {
  const s = statusLicenca();
  if (!s.permitido) throw new ErroNegocio(s.mensagem, 402);
}

const SQL_CLIENTES = `SELECT documento FROM empresas WHERE na_carteira = 1 UNION SELECT documento FROM tomadores WHERE documento IS NOT NULL`;

/** Quantidade já cadastrada de cada coisa que o plano limita: empresas do sistema e clientes (carteira e cadastro de clientes, sem repetir). */
export function usoAtual() {
  return {
    empresas: (db.prepare('SELECT COUNT(*) n FROM empresas WHERE gerencia = 1').get() as any).n as number,
    clientes: (db.prepare(`SELECT COUNT(*) n FROM (${SQL_CLIENTES})`).get() as any).n as number,
  };
}

/** Recusa um novo cadastro que ultrapassaria o limite do plano. Cliente que já existe (mesmo documento) não conta de novo. */
export function exigirLimite(tipo: 'empresas' | 'clientes', documento?: string | null): void {
  const s = statusLicenca();
  const max = s.limites[tipo];
  if (max == null) return;
  if (tipo === 'clientes' && documento && db.prepare(`SELECT 1 FROM (${SQL_CLIENTES}) WHERE documento = ?`).get(documento)) return;
  const usado = usoAtual()[tipo];
  if (usado < max) return;
  const nome = tipo === 'empresas' ? (max === 1 ? '1 empresa' : `${max} empresas`) : (max === 1 ? '1 cliente' : `${max} clientes`);
  throw new ErroNegocio(`O plano ${s.planoNome} permite ${nome}. Para cadastrar mais, altere o plano em Configurações > Licença.`, 402);
}
