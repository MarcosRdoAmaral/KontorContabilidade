import https from 'node:https';
import { z } from 'zod';
import { db } from '../db.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { ErroNegocio, certificadoDaEmpresa } from './emissao.js';
import { atualizarTarefa, listarTarefas } from './obrigacoes.js';

/**
 * Integra Contador (SERPRO): consulta, em nome dos clientes, o que foi transmitido à Receita Federal.
 *
 * O escritório contrata o serviço na Loja Serpro (recebe Consumer Key e Consumer Secret) e cada cliente dá
 * procuração eletrônica ao escritório no e-CAC. A autenticação usa o certificado A1 do escritório (TLS mútuo).
 * Hoje o sistema confere: PGDAS-D (DAS do Simples, com a informação de DAS pago), DCTFWeb e DEFIS.
 */

const URL_AUTH = 'https://autenticacao.sapi.serpro.gov.br/authenticate';
const URL_API: Record<Ambiente, string> = {
  PRODUCAO: 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1',
  DEMONSTRACAO: 'https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1',
};
/** Token público do ambiente de demonstração (dados fictícios, sem certificado nem contrato). */
const TOKEN_DEMONSTRACAO = '06aef429-a981-3ec5-a1f8-71d38d86481e';

export type Ambiente = 'PRODUCAO' | 'DEMONSTRACAO';
const P_CONFIG = (e: number) => `integra_contador:${e}`;

export const ConfigIntegra = z.object({
  ambiente: z.enum(['PRODUCAO', 'DEMONSTRACAO']),
  consumerKey: z.string().trim().max(200).nullish(),
  consumerSecret: z.string().trim().max(200).nullish(),
  /** Ajuste avançado: "SITFIS=2.0; PGDASD=1.0" (para quando o SERPRO descontinuar uma versão). */
  versoes: z.string().trim().max(300).nullish(),
});

/** Versão atual de cada sistema no catálogo do Integra Contador (os não listados usam 1.0). */
export const VERSOES_PADRAO: Record<string, string> = { SITFIS: '2.0', SICALC: '2.9', PROCURACOES: '1' };

/** "SITFIS=2.0; PGDASD = 1.0" → { SITFIS: '2.0', PGDASD: '1.0' } */
export function lerVersoes(texto?: string | null): Record<string, string> {
  const r: Record<string, string> = {};
  for (const par of String(texto ?? '').split(/[;,\n]+/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(par);
    if (m) r[m[1].toUpperCase()] = m[2];
  }
  return r;
}

interface ConfigSalva { ambiente: Ambiente; consumerKey: string | null; consumerSecretEnc: string | null; versoes?: string | null }

export function lerConfig(escritorioId: number): ConfigSalva | null {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(P_CONFIG(escritorioId)) as any)?.valor;
  return v ? JSON.parse(v) : null;
}

export function configPublica(escritorioId: number) {
  const c = lerConfig(escritorioId);
  const esc = db.prepare('SELECT documento, razao_social, (cert_pfx_enc IS NOT NULL) AS tem_cert, cert_validade FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  return {
    configurado: !!c && (c.ambiente === 'DEMONSTRACAO' || (!!c.consumerKey && !!c.consumerSecretEnc)),
    ambiente: c?.ambiente ?? 'PRODUCAO', consumerKey: c?.consumerKey ?? '', temSecret: !!c?.consumerSecretEnc, versoes: c?.versoes ?? '', versoesPadrao: VERSOES_PADRAO,
    escritorio: esc ? { documento: esc.documento, nome: esc.razao_social, temCertificado: !!esc.tem_cert, certValidade: esc.cert_validade } : null,
  };
}

export function salvarConfig(escritorioId: number, d: z.infer<typeof ConfigIntegra>) {
  const atual = lerConfig(escritorioId);
  const secretEnc = d.consumerSecret ? cifrarTexto(d.consumerSecret) : atual?.consumerSecretEnc ?? null;
  if (d.ambiente === 'PRODUCAO' && (!d.consumerKey || !secretEnc)) throw new ErroNegocio('Informe o Consumer Key e o Consumer Secret recebidos na contratação (Área do Cliente Serpro).');
  if (d.versoes && !Object.keys(lerVersoes(d.versoes)).length) throw new ErroNegocio('Versões: use o formato SISTEMA=versão, separados por ponto e vírgula (ex.: SITFIS=2.0; PGDASD=1.0).');
  const nova: ConfigSalva = { ambiente: d.ambiente, consumerKey: d.consumerKey || null, consumerSecretEnc: secretEnc, versoes: d.versoes || null };
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(P_CONFIG(escritorioId), JSON.stringify(nova));
  tokens.delete(escritorioId);
}

// ---------------------------------------------------------------------------------------------
// Transporte (trocável nos testes)
// ---------------------------------------------------------------------------------------------

export type Endpoint = 'Consultar' | 'Apoiar' | 'Emitir' | 'Declarar';
export interface Token { accessToken: string; jwtToken: string; expiraEm: number }
export interface Transporte {
  autenticar(): Promise<Token>;
  consultar(corpo: object, token: Token, endpoint?: Endpoint): Promise<{ status: number; corpo: any }>;
}

function requisicao(url: string, opcoes: https.RequestOptions, corpo: string): Promise<{ status: number; corpo: any; bruto: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { ...opcoes, timeout: 60_000 }, (res) => {
      const partes: Buffer[] = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const bruto = Buffer.concat(partes).toString('utf8');
        let json: any = null;
        try { json = bruto ? JSON.parse(bruto) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, corpo: json, bruto });
      });
    });
    r.on('timeout', () => r.destroy(new Error('Tempo esgotado aguardando o Integra Contador.')));
    r.on('error', reject);
    r.end(corpo);
  });
}

function transporteReal(escritorioId: number): Transporte {
  const cfg = lerConfig(escritorioId);
  if (!cfg) throw new ErroNegocio('Configure o Integra Contador em Configurações > Integra Contador.');
  const api = URL_API[cfg.ambiente];
  return {
    async autenticar() {
      if (cfg.ambiente === 'DEMONSTRACAO') return { accessToken: TOKEN_DEMONSTRACAO, jwtToken: TOKEN_DEMONSTRACAO, expiraEm: Date.now() + 3600e3 };
      const esc = db.prepare('SELECT * FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
      if (!esc?.cert_pfx_enc) throw new ErroNegocio('Envie o certificado A1 (e-CNPJ) do escritório em Cadastros > Empresas: o Integra Contador autentica com ele.');
      const cert = certificadoDaEmpresa(esc);
      const agent = new https.Agent({ key: cert.chavePem, cert: cert.cadeiaPem });
      const basic = Buffer.from(`${cfg.consumerKey}:${decifrarTexto(cfg.consumerSecretEnc!)}`).toString('base64');
      const r = await requisicao(URL_AUTH, { method: 'POST', agent, headers: { Authorization: `Basic ${basic}`, 'Role-Type': 'TERCEIROS', 'Content-Type': 'application/x-www-form-urlencoded' } }, 'grant_type=client_credentials');
      if (r.status === 401 || r.status === 403) throw new ErroNegocio('O SERPRO recusou a autenticação: confira o Consumer Key e o Consumer Secret, se o contrato está ativo e se o certificado é do mesmo CNPJ do contrato.', 502);
      if (r.status !== 200 || !r.corpo?.access_token) throw new ErroNegocio(`Falha ao autenticar no Integra Contador (HTTP ${r.status}).`, 502);
      return { accessToken: r.corpo.access_token, jwtToken: r.corpo.jwt_token, expiraEm: Date.now() + (Number(r.corpo.expires_in) || 1800) * 1000 - 60_000 };
    },
    async consultar(corpo, token, endpoint = 'Consultar') {
      const r = await requisicao(`${api}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, jwt_token: token.jwtToken, 'Content-Type': 'application/json', Accept: 'application/json' } }, JSON.stringify(corpo));
      return { status: r.status, corpo: r.corpo };
    },
  };
}

const tokens = new Map<number, Token>();

// ---------------------------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------------------------

const tipoDoc = (d: string) => (d.length === 11 ? 1 : 2);

export class Integra {
  constructor(private escritorioId: number, private transporte: Transporte, private documentoEscritorio: string) {}

  static para(escritorioId: number, transporte?: Transporte) {
    const esc = db.prepare('SELECT documento FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
    if (!esc) throw new ErroNegocio('Marque em Cadastros > Empresas qual é a empresa do escritório: ela é a contratante do Integra Contador.');
    return new Integra(escritorioId, transporte ?? transporteReal(escritorioId), esc.documento);
  }

  /** Versão do sistema: o ajuste da configuração, senão a do catálogo, senão 1.0. */
  versao(idSistema: string) {
    return lerVersoes(lerConfig(this.escritorioId)?.versoes)[idSistema] ?? VERSOES_PADRAO[idSistema] ?? '1.0';
  }

  private async token() {
    const t = tokens.get(this.escritorioId);
    if (t && t.expiraEm > Date.now()) return t;
    const novo = await this.transporte.autenticar();
    tokens.set(this.escritorioId, novo);
    return novo;
  }

  /** Uma consulta. Devolve os dados já interpretados (o campo "dados" vem como texto JSON) e as mensagens. */
  async consultar(contribuinte: string, idSistema: string, idServico: string, dados: object | null, endpoint: Endpoint = 'Consultar') {
    const corpo = {
      contratante: { numero: this.documentoEscritorio, tipo: 2 },
      autorPedidoDados: { numero: this.documentoEscritorio, tipo: 2 },
      contribuinte: { numero: contribuinte, tipo: tipoDoc(contribuinte) },
      pedidoDados: { idSistema, idServico, versaoSistema: this.versao(idSistema), dados: dados ? JSON.stringify(dados) : '' },
    };
    let r = await this.transporte.consultar(corpo, await this.token(), endpoint);
    if (r.status === 401) { tokens.delete(this.escritorioId); r = await this.transporte.consultar(corpo, await this.token(), endpoint); }
    const msgs: { codigo: string; texto: string }[] = ([] as any[]).concat(r.corpo?.mensagens ?? []).map((m: any) => ({ codigo: String(m?.codigo ?? ''), texto: String(m?.texto ?? '') }));
    let dadosLidos: any = null;
    const bruto = r.corpo?.dados;
    if (typeof bruto === 'string' && bruto.trim()) { try { dadosLidos = JSON.parse(bruto); } catch { dadosLidos = bruto; } } else if (bruto && typeof bruto === 'object') dadosLidos = bruto;
    return { http: r.status, ok: r.status >= 200 && r.status < 300 && Number(r.corpo?.status ?? r.status) < 300, dados: dadosLidos, mensagens: msgs };
  }
}

export const textoMsgs = (m: { codigo: string; texto: string }[]) => {
  const t = m.map((x) => x.texto || x.codigo).filter(Boolean).join(' ');
  return /vers[ãa]o descontinuada/i.test(t) ? `${t} O SERPRO mudou a versão deste serviço: ajuste em Configurações > Integra Contador > Versões dos serviços (ou avise o suporte do Kontor).` : t;
};
export const semProcuracao = (m: { codigo: string; texto: string }[]) => m.some((x) => /AcessoNegado|procura/i.test(`${x.codigo} ${x.texto}`));

/** "20240315103000", "2024-03-15T10:30" ou número → AAAA-MM-DD. */
export function dataDaReceita(v: unknown): string | null {
  const s = String(v ?? '');
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s.replace(/[^\d-T:]/g, ''));
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
}

export interface Achado { entregue: boolean; protocolo?: string | null; data?: string | null; detalhe?: string | null; erro?: string | null }

/** PGDAS-D do ano inteiro numa consulta só: devolve o achado por período (AAAAMM). */
export async function declaracoesPgdasd(i: Integra, cnpj: string, ano: string): Promise<{ erro: string | null; porPeriodo: Map<string, Achado> }> {
  const r = await i.consultar(cnpj, 'PGDASD', 'CONSDECLARACAO13', { anoCalendario: ano });
  const porPeriodo = new Map<string, Achado>();
  if (!r.ok) return { erro: semProcuracao(r.mensagens) ? 'sem procuração do cliente para o escritório no e-CAC (Simples Nacional)' : textoMsgs(r.mensagens) || `HTTP ${r.http}`, porPeriodo };
  const periodos: any[] = r.dados?.periodos ?? (r.dados?.periodo ? [r.dados.periodo] : []);
  for (const p of periodos) {
    const ops: any[] = p.operacoes ?? [];
    const decl = ops.filter((o) => o.indiceDeclaracao).pop();
    if (!decl) continue;
    const pago = ops.some((o) => o.indiceDas?.dasPago === true);
    const temDas = ops.some((o) => o.indiceDas);
    porPeriodo.set(String(p.periodoApuracao), {
      entregue: true, protocolo: String(decl.indiceDeclaracao.numeroDeclaracao ?? ''), data: dataDaReceita(decl.indiceDeclaracao.dataHoraTransmissao),
      detalhe: `PGDAS-D transmitido${decl.tipoOperacao ? ` (${decl.tipoOperacao})` : ''}${temDas ? (pago ? '; DAS pago' : '; DAS ainda não consta como pago') : '; DAS não gerado'}`,
    });
  }
  return { erro: null, porPeriodo };
}

export async function reciboDctfweb(i: Integra, cnpj: string, competencia: string): Promise<Achado> {
  const r = await i.consultar(cnpj, 'DCTFWEB', 'CONSRECIBO32', { categoria: 'GERAL_MENSAL', anoPA: competencia.slice(0, 4), mesPA: competencia.slice(5, 7) });
  if (r.ok && r.dados) return { entregue: true, protocolo: r.dados?.numeroRecibo ?? r.dados?.numeroReciboEntrega ?? null, detalhe: 'Recibo da DCTFWeb localizado' };
  if (semProcuracao(r.mensagens)) return { entregue: false, erro: 'sem procuração do cliente para o escritório no e-CAC (DCTFWeb)' };
  return { entregue: false, detalhe: textoMsgs(r.mensagens) || 'Recibo não localizado' };
}

export async function declaracoesDefis(i: Integra, cnpj: string): Promise<{ erro: string | null; porAno: Map<string, Achado> }> {
  const r = await i.consultar(cnpj, 'DEFIS', 'CONSDECLARACAO142', null);
  const porAno = new Map<string, Achado>();
  if (!r.ok) return { erro: semProcuracao(r.mensagens) ? 'sem procuração do cliente para o escritório no e-CAC (DEFIS)' : textoMsgs(r.mensagens) || `HTTP ${r.http}`, porAno };
  for (const d of ([] as any[]).concat(r.dados ?? [])) {
    const ano = String(d.anoCalendario ?? '');
    if (ano) porAno.set(ano, { entregue: true, protocolo: d.idDefis != null ? String(d.idDefis) : null, data: dataDaReceita(d.dataHora), detalhe: `DEFIS transmitida${d.tipo ? ` (${d.tipo})` : ''}` });
  }
  return { erro: null, porAno };
}

// ---------------------------------------------------------------------------------------------
// Conferência das obrigações
// ---------------------------------------------------------------------------------------------

/** Obrigações do catálogo (pelo código) que o Integra Contador sabe conferir. */
export const CONFERIVEIS: Record<string, string> = { DAS: 'PGDAS-D', DCTFWEB: 'DCTFWeb', DEFIS: 'DEFIS' };

/** Tarefas em aberto que a Receita confere; com `tarefas`, só as selecionadas na tela. */
function tarefasConferiveis(escritorioId: number, mes: string, empresas: number[] | null, tarefas?: number[] | null) {
  const sel = tarefas?.length ? new Set(tarefas) : null;
  return listarTarefas(escritorioId, { mes, atrasadas: true, empresas })
    .filter((t) => CONFERIVEIS[t.codigo] && (t.status === 'PENDENTE' || t.status === 'ANDAMENTO') && (!sel || sel.has(t.id)));
}

/** Quantas consultas a conferência vai fazer (o SERPRO cobra por consulta). */
export function previaConferencia(escritorioId: number, mes: string, empresas: number[] | null = null, tarefas: number[] | null = null) {
  const ts = tarefasConferiveis(escritorioId, mes, empresas, tarefas);
  const chaves = new Set<string>();
  for (const t of ts) chaves.add(t.codigo === 'DAS' ? `${t.empresa_id}:DAS:${t.competencia.slice(0, 4)}` : t.codigo === 'DEFIS' ? `${t.empresa_id}:DEFIS` : `${t.empresa_id}:DCTF:${t.competencia}`);
  return { tarefas: ts.length, consultas: chaves.size, clientes: [...new Set(ts.map((t) => t.cliente))], porObrigacao: Object.fromEntries(Object.keys(CONFERIVEIS).map((k) => [k, ts.filter((t) => t.codigo === k).length])) };
}

export interface ResultadoConferencia { tarefa_id: number; cliente: string; codigo: string; competencia: string; situacao: 'ENTREGUE' | 'NAO_ENCONTRADA' | 'ERRO'; mensagem: string }

export async function conferirNaReceita(escritorioId: number, usuarioId: number, mes: string, empresas: number[] | null = null, transporte?: Transporte, tarefas: number[] | null = null) {
  if (!transporte && lerConfig(escritorioId)?.ambiente === 'DEMONSTRACAO') {
    throw new ErroNegocio('O Integra Contador está no ambiente de Demonstração, que só responde com dados fictícios. Troque para Produção em Configurações > Integra Contador quando o contrato estiver ativo.');
  }
  const i = Integra.para(escritorioId, transporte);
  const ts = tarefasConferiveis(escritorioId, mes, empresas, tarefas);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const cachePg = new Map<string, Awaited<ReturnType<typeof declaracoesPgdasd>>>();
  const cacheDefis = new Map<string, Awaited<ReturnType<typeof declaracoesDefis>>>();
  const resultados: ResultadoConferencia[] = [];
  for (const t of ts) {
    const base = { tarefa_id: t.id, cliente: t.cliente, codigo: t.codigo, competencia: t.competencia_rotulo };
    try {
      let achado: Achado;
      if (t.codigo === 'DAS') {
        const k = `${t.documento}:${t.competencia.slice(0, 4)}`;
        if (!cachePg.has(k)) cachePg.set(k, await declaracoesPgdasd(i, t.documento, t.competencia.slice(0, 4)));
        const c = cachePg.get(k)!;
        achado = c.erro ? { entregue: false, erro: c.erro } : c.porPeriodo.get(t.competencia.replace('-', '')) ?? { entregue: false, detalhe: 'PGDAS-D do período não localizado' };
      } else if (t.codigo === 'DEFIS') {
        if (!cacheDefis.has(t.documento)) cacheDefis.set(t.documento, await declaracoesDefis(i, t.documento));
        const c = cacheDefis.get(t.documento)!;
        achado = c.erro ? { entregue: false, erro: c.erro } : c.porAno.get(t.competencia) ?? { entregue: false, detalhe: 'DEFIS do ano não localizada' };
      } else {
        achado = await reciboDctfweb(i, t.documento, t.competencia);
      }
      if (achado.erro) { resultados.push({ ...base, situacao: 'ERRO', mensagem: achado.erro }); continue; }
      if (!achado.entregue) { resultados.push({ ...base, situacao: 'NAO_ENCONTRADA', mensagem: achado.detalhe ?? 'Não localizada na Receita' }); continue; }
      const obs = `${achado.detalhe ?? 'Entrega localizada'}. Conferido na Receita (Integra Contador) em ${hoje.split('-').reverse().join('/')}.`;
      atualizarTarefa(escritorioId, usuarioId, t.id, {
        status: 'ENTREGUE', responsavel_id: t.responsavel_id ?? null, protocolo: achado.protocolo || t.protocolo || null,
        observacao: t.observacao ? `${t.observacao}\n${obs}` : obs, entregue_em: achado.data ?? hoje,
      });
      resultados.push({ ...base, situacao: 'ENTREGUE', mensagem: obs });
    } catch (e: any) {
      resultados.push({ ...base, situacao: 'ERRO', mensagem: String(e?.message ?? e) });
      if (e instanceof ErroNegocio && /autentica|Consumer|certificado A1|Configure/.test(e.message)) break; // problema geral: não adianta seguir
    }
  }
  return {
    conferidas: resultados.length,
    entregues: resultados.filter((r) => r.situacao === 'ENTREGUE').length,
    naoEncontradas: resultados.filter((r) => r.situacao === 'NAO_ENCONTRADA').length,
    erros: resultados.filter((r) => r.situacao === 'ERRO').length,
    resultados,
  };
}

/** Teste da configuração: autentica (produção) e, na demonstração, faz uma consulta de exemplo. */
export async function testarConexao(escritorioId: number, transporte?: Transporte) {
  const cfg = lerConfig(escritorioId);
  if (!cfg) throw new ErroNegocio('Salve a configuração antes de testar.');
  tokens.delete(escritorioId);
  if (cfg.ambiente === 'DEMONSTRACAO') {
    // a demonstração só responde para os CNPJs de exemplo do SERPRO
    const demo = new Integra(escritorioId, transporte ?? transporteReal(escritorioId), '00000000000100');
    const r = await demo.consultar('00000000000000', 'DEFIS', 'CONSDECLARACAO142', null);
    tokens.delete(escritorioId);
    return { ok: r.ok, mensagem: r.ok ? 'O ambiente de demonstração respondeu (dados fictícios). Troque para Produção quando o contrato estiver ativo.' : `A demonstração respondeu com erro: ${textoMsgs(r.mensagens) || r.http}` };
  }
  const i = Integra.para(escritorioId, transporte);
  if (cfg.ambiente === 'PRODUCAO') {
    await (i as any).token();
    return { ok: true, mensagem: 'Autenticação feita com sucesso. As consultas dependem da procuração de cada cliente para o escritório no e-CAC.' };
  }
  const r = await i.consultar('00000000000100', 'DEFIS', 'CONSDECLARACAO142', null);
  return { ok: r.ok, mensagem: r.ok ? 'Ambiente de demonstração respondeu (dados fictícios). Troque para Produção quando o contrato estiver ativo.' : `Demonstração respondeu com erro: ${textoMsgs(r.mensagens) || r.http}` };
}
