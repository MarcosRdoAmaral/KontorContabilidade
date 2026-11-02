import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { ErroNegocio } from './emissao.js';
import { casaDosDados, demonstracao, ErroProvedor, type EmpresaRadar, type FiltrosRadar, type Provedor } from '../radar/provedores.js';

/**
 * Radar de Oportunidades: pesquisa de empresas (novas e já existentes) numa fonte de dados cadastrais e CRM de
 * prospecção do escritório. O cadastro público fica em cache por CNPJ (radar_empresas, com origem e data); o que é
 * do escritório (o que ele viu, leads, contatos, auditoria) é sempre separado por escritorio_id.
 */

export const ESTAGIOS = {
  NOVO: 'Novo lead', NAO_CONTATADO: 'Não contatado', PRIMEIRO_CONTATO: 'Primeiro contato realizado', EM_NEGOCIACAO: 'Em negociação',
  AGUARDANDO_RETORNO: 'Aguardando retorno', CONVERTIDO: 'Convertido em cliente', NAO_INTERESSADO: 'Não interessado',
} as const;
export type Estagio = keyof typeof ESTAGIOS;
export const ORIGENS = { RADAR: 'Radar de Oportunidades', INDICACAO: 'Indicação', SITE: 'Site', EVENTO: 'Evento', IMPORTACAO: 'Importação', OUTRO: 'Outro' } as const;
export const CANAIS = { TELEFONE: 'Telefone', WHATSAPP: 'WhatsApp', EMAIL: 'E-mail', VISITA: 'Visita', REUNIAO: 'Reunião', OUTRO: 'Outro' } as const;

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const so = (s: unknown) => String(s ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------------------------------------
// Configuração (fonte de dados, cache e critérios de potencial)
// ---------------------------------------------------------------------------------------------

export const Criterio = z.object({
  id: z.string().trim().min(1).max(40),
  nome: z.string().trim().min(2).max(80),
  cnaes: z.array(z.string().regex(/^\d{2,7}$/)).max(200).default([]),        // começo do código CNAE (divisão, grupo ou código)
  palavras: z.array(z.string().trim().min(3).max(40)).max(50).default([]),  // palavras na descrição da atividade
  peso: z.number().int().min(1).max(10).default(1),
});
export type Criterio = z.infer<typeof Criterio>;

/** Critérios sugeridos (o escritório ajusta). Servem só para estimar a oportunidade, nunca para afirmar a necessidade. */
export const CRITERIOS_PADRAO: Criterio[] = [
  { id: 'servicos', nome: 'Prestador de serviços', cnaes: ['45', '55', '56', '59', '60', '62', '63', '69', '70', '71', '72', '73', '74', '75', '77', '78', '79', '80', '81', '82', '85', '86', '87', '88', '90', '93', '95', '96'], palavras: ['servi', 'consultoria', 'manutenção', 'reparação'], peso: 3 },
  { id: 'nfse', nome: 'Pode emitir NFS-e', cnaes: ['62', '63', '69', '70', '71', '72', '73', '74', '78', '80', '81', '82', '85', '86', '96'], palavras: [], peso: 2 },
  { id: 'boletos', nome: 'Pode cobrar com boleto recorrente', cnaes: ['6110', '6190', '6201', '6203', '6311', '6822', '7711', '8130', '8511', '8512', '8513', '8520', '8531', '8541', '8592', '8593', '8599', '8630', '8650', '9313'], palavras: ['mensalidade', 'assinatura', 'locação', 'administração'], peso: 2 },
  { id: 'cobranca', nome: 'Perfil para automação de cobranças', cnaes: ['68', '77', '85', '86', '93'], palavras: ['escola', 'curso', 'academia', 'condomínio', 'clínica'], peso: 1 },
];

export const ConfigRadar = z.object({
  provedor: z.enum(['CASA_DOS_DADOS', 'DEMONSTRACAO']),
  apiKey: z.string().trim().max(300).nullish(),          // vazio = mantém a chave guardada
  cacheHoras: z.number().int().min(1).max(720).default(24),
  ufPadrao: z.string().length(2).nullish(),
  municipioPadrao: z.string().trim().max(80).nullish(),
  criterios: z.array(Criterio).max(30).nullish(),
});
interface ConfigSalva { provedor: 'CASA_DOS_DADOS' | 'DEMONSTRACAO'; apiKeyEnc: string | null; cacheHoras: number; ufPadrao: string | null; municipioPadrao: string | null; criterios: Criterio[] | null }

const P = (e: number) => `radar:${e}`;
export function lerConfigRadar(escritorioId: number): ConfigSalva {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(P(escritorioId)) as any)?.valor;
  return v ? JSON.parse(v) : { provedor: 'DEMONSTRACAO', apiKeyEnc: null, cacheHoras: 24, ufPadrao: null, municipioPadrao: null, criterios: null };
}
export function configPublicaRadar(escritorioId: number) {
  const c = lerConfigRadar(escritorioId);
  const real = c.provedor === 'CASA_DOS_DADOS' && !!c.apiKeyEnc;
  return { provedor: real ? 'CASA_DOS_DADOS' : 'DEMONSTRACAO', provedorEscolhido: c.provedor, temChave: !!c.apiKeyEnc, demonstracao: !real, cacheHoras: c.cacheHoras,
    ufPadrao: c.ufPadrao, municipioPadrao: c.municipioPadrao, criterios: c.criterios ?? CRITERIOS_PADRAO, criteriosPadrao: !c.criterios, estagios: ESTAGIOS, origens: ORIGENS, canais: CANAIS };
}
export function salvarConfigRadar(escritorioId: number, usuarioId: number, d: z.infer<typeof ConfigRadar>) {
  const atual = lerConfigRadar(escritorioId);
  const apiKeyEnc = d.apiKey ? cifrarTexto(d.apiKey) : atual.apiKeyEnc;
  if (d.provedor === 'CASA_DOS_DADOS' && !apiKeyEnc) throw new ErroNegocio('Informe a chave de API (api-key) da Casa dos Dados.');
  const nova: ConfigSalva = { provedor: d.provedor, apiKeyEnc, cacheHoras: d.cacheHoras, ufPadrao: d.ufPadrao?.toUpperCase() ?? null, municipioPadrao: d.municipioPadrao || null, criterios: d.criterios ?? atual.criterios };
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(P(escritorioId), JSON.stringify(nova));
  auditar(escritorioId, usuarioId, 'CONFIG', null, `fonte ${d.provedor}${d.apiKey ? ', chave trocada' : ''}`);
  return configPublicaRadar(escritorioId);
}

/** Fonte de dados do escritório (testes trocam pelo parâmetro). */
let provedorTeste: ((escritorioId: number) => Provedor) | null = null;
export const trocarProvedorRadar = (f: typeof provedorTeste) => { provedorTeste = f; };
function provedorDo(escritorioId: number): Provedor {
  if (provedorTeste) return provedorTeste(escritorioId);
  const c = lerConfigRadar(escritorioId);
  if (c.provedor === 'CASA_DOS_DADOS' && c.apiKeyEnc) return casaDosDados(decifrarTexto(c.apiKeyEnc));
  return demonstracao();
}

// ---------------------------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------------------------

export function auditar(escritorioId: number, usuarioId: number | null, acao: string, alvo: string | null, detalhe: string | null = null) {
  db.prepare('INSERT INTO radar_auditoria (escritorio_id, usuario_id, acao, alvo, detalhe) VALUES (?,?,?,?,?)').run(escritorioId, usuarioId, acao, alvo, detalhe?.slice(0, 500) ?? null);
}
export function listarAuditoria(escritorioId: number, limite = 200) {
  return db.prepare(`SELECT a.criado_em, a.acao, a.alvo, a.detalhe, u.nome AS usuario FROM radar_auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.escritorio_id = ? ORDER BY a.id DESC LIMIT ?`).all(escritorioId, limite);
}

// ---------------------------------------------------------------------------------------------
// Cache por CNPJ (sem duplicidade; mudanças no cadastro ficam registradas)
// ---------------------------------------------------------------------------------------------

const CAMPOS = ['razao_social', 'nome_fantasia', 'data_abertura', 'uf', 'municipio', 'cod_municipio', 'cnae', 'cnae_descricao', 'natureza_codigo', 'natureza_descricao', 'situacao', 'porte', 'telefone', 'email', 'capital_social'] as const;
const ROTULO_CAMPO: Record<string, string> = { razao_social: 'Razão social', nome_fantasia: 'Nome fantasia', situacao: 'Situação cadastral', municipio: 'Município', uf: 'UF', cnae: 'CNAE', porte: 'Porte', telefone: 'Telefone', email: 'E-mail', natureza_codigo: 'Natureza jurídica', endereco: 'Endereço' };

const vazio = (v: unknown) => v == null || String(v).trim() === '';
/** Endereço sem as partes vazias (para comparar e para completar). */
const endLimpo = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => !vazio(v)));

/**
 * Grava ou atualiza a empresa; devolve as mudanças em relação ao que estava guardado.
 * A pesquisa traz só parte do cadastro e a consulta por CNPJ traz o restante: campo que a fonte não trouxe mantém o valor
 * guardado, e preencher um campo que estava vazio é complemento, não alteração cadastral (não entra no histórico).
 */
export function guardarEmpresa(e: EmpresaRadar, origem: string, demonstracao: boolean): { campo: string; de: unknown; para: unknown }[] {
  const atual = db.prepare('SELECT * FROM radar_empresas WHERE cnpj = ?').get(e.cnpj) as any;
  const endNovo = endLimpo(e.endereco);
  const endAtual = endLimpo(atual?.endereco_json ? JSON.parse(atual.endereco_json) : {});
  const endereco = JSON.stringify({ ...endAtual, ...endNovo });
  if (!atual) {
    db.prepare(`INSERT INTO radar_empresas (cnpj, ${CAMPOS.join(', ')}, endereco_json, origem, demonstracao) VALUES (?, ${CAMPOS.map(() => '?').join(', ')}, ?, ?, ?)`)
      .run(e.cnpj, ...CAMPOS.map((c) => (e as any)[c] ?? null), endereco, origem, demonstracao ? 1 : 0);
    return [];
  }
  const mud: { campo: string; de: unknown; para: unknown }[] = [];
  for (const c of CAMPOS) {
    const novo = (e as any)[c];
    if (vazio(novo) || vazio(atual[c])) continue; // a fonte não trouxe (mantém) ou o campo estava vazio (complemento)
    if (String(novo) !== String(atual[c]) && ROTULO_CAMPO[c]) mud.push({ campo: c, de: atual[c], para: novo });
  }
  // endereço: só conta como alteração quando já havia endereço e uma parte informada mudou
  if (Object.keys(endAtual).length && Object.keys(endNovo).length && Object.entries(endNovo).some(([k, v]) => k in endAtual && String(endAtual[k]) !== String(v))) {
    mud.push({ campo: 'endereco', de: endAtual, para: { ...endAtual, ...endNovo } });
  }
  const hist = atual.alteracoes_json ? JSON.parse(atual.alteracoes_json) : [];
  if (mud.length && !demonstracao) hist.unshift({ em: new Date().toISOString(), origem, mudancas: mud });
  db.prepare(`UPDATE radar_empresas SET ${CAMPOS.map((c) => `${c} = COALESCE(?, ${c})`).join(', ')},
      endereco_json = ?, origem = ?, demonstracao = ?, alteracoes_json = ?, atualizado_em = datetime('now') WHERE cnpj = ?`)
    .run(...CAMPOS.map((c) => (vazio((e as any)[c]) ? null : (e as any)[c])), endereco, origem, demonstracao ? 1 : 0, hist.length ? JSON.stringify(hist.slice(0, 30)) : null, e.cnpj);
  return mud;
}

// ---------------------------------------------------------------------------------------------
// Potencial comercial estimado
// ---------------------------------------------------------------------------------------------

export function potencial(e: { cnae: string | null; cnae_descricao: string | null; situacao?: string | null }, criterios: Criterio[]) {
  if (e.situacao && e.situacao !== 'ATIVA') return { nivel: null as 'ALTO' | 'MEDIO' | 'BAIXO' | null, pontos: 0, motivos: [] as string[] };
  const cnae = so(e.cnae), desc = String(e.cnae_descricao ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  let pontos = 0; const motivos: string[] = [];
  for (const c of criterios) {
    const porCnae = c.cnaes.some((p) => cnae.startsWith(p));
    const porPalavra = c.palavras.some((w) => desc.includes(w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()));
    if (porCnae || porPalavra) { pontos += c.peso; motivos.push(c.nome); }
  }
  const total = criterios.reduce((t, c) => t + c.peso, 0) || 1;
  const nivel = !pontos ? 'BAIXO' : pontos / total >= 0.6 ? 'ALTO' : pontos / total >= 0.3 ? 'MEDIO' : 'BAIXO';
  return { nivel: nivel as 'ALTO' | 'MEDIO' | 'BAIXO', pontos, motivos };
}

// ---------------------------------------------------------------------------------------------
// Pesquisa
// ---------------------------------------------------------------------------------------------

export const Pesquisa = z.object({
  modo: z.enum(['NOVAS', 'TODAS', 'CARTEIRA']).default('NOVAS'),
  texto: z.string().trim().max(120).nullish(),
  uf: z.string().trim().length(2).nullish().or(z.literal('').transform(() => null)),
  municipio: z.string().trim().max(80).nullish(),
  aberturaDe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  aberturaAte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  dias: z.coerce.number().int().min(1).max(3650).nullish(),
  cnae: z.string().trim().regex(/^[\d.\-/]{0,12}$/).nullish(),
  atividade: z.string().trim().max(80).nullish(),
  situacao: z.enum(['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA', 'NULA']).nullish().or(z.literal('').transform(() => null)),
  natureza: z.string().trim().regex(/^\d{0,4}$/).nullish(),
  porte: z.enum(['ME', 'EPP', 'DEMAIS']).nullish().or(z.literal('').transform(() => null)),
  comTelefone: z.boolean().nullish(),
  comEmail: z.boolean().nullish(),
  potencial: z.enum(['ALTO', 'MEDIO', 'BAIXO']).nullish().or(z.literal('').transform(() => null)),
  estagio: z.string().max(30).nullish(),
  ordem: z.enum(['RECENTES', 'ANTIGAS', 'NOME', 'POTENCIAL']).default('RECENTES'),
  pagina: z.coerce.number().int().min(1).max(500).default(1),
  limite: z.coerce.number().int().min(5).max(100).default(25),
  atualizar: z.boolean().default(false),          // ignora o cache e consulta a fonte de novo
});
export type Pesquisa = z.infer<typeof Pesquisa>;

const linhaEmpresa = (r: any, criterios: Criterio[]) => ({
  ...r, endereco: r.endereco_json ? JSON.parse(r.endereco_json) : {}, endereco_json: undefined, alteracoes_json: undefined, demonstracao: !!r.demonstracao,
  potencial: potencial(r, criterios),
  lead: r.lead_id ? { id: r.lead_id, estagio: r.lead_estagio, rotulo: ESTAGIOS[r.lead_estagio as Estagio], responsavel: r.lead_responsavel ?? null, proximo_contato: r.lead_proximo ?? null } : null,
});
const SELECT_EMP = `SELECT e.*, l.id AS lead_id, l.estagio AS lead_estagio, l.proximo_contato AS lead_proximo, u.nome AS lead_responsavel
  FROM radar_empresas e LEFT JOIN radar_leads l ON l.cnpj = e.cnpj AND l.escritorio_id = ? LEFT JOIN usuarios u ON u.id = l.responsavel_id`;

export async function pesquisar(escritorioId: number, usuarioId: number, p: Pesquisa) {
  const cfg = configPublicaRadar(escritorioId);
  const criterios = cfg.criterios;
  if (p.modo === 'CARTEIRA') return carteira(escritorioId, p, criterios);
  const prov = provedorDo(escritorioId);
  const f: FiltrosRadar = { texto: p.texto, uf: p.uf, municipio: p.municipio, aberturaDe: p.aberturaDe, aberturaAte: p.aberturaAte, cnae: p.cnae, atividade: p.atividade,
    situacao: p.situacao, natureza: p.natureza, porte: p.porte, comTelefone: p.comTelefone, comEmail: p.comEmail };
  if (p.modo === 'NOVAS' && !f.aberturaDe) f.aberturaDe = somaDias(hojeBr(), -(p.dias ?? 30));
  if (p.modo === 'NOVAS' && !f.situacao) f.situacao = 'ATIVA';
  if (f.aberturaDe && f.aberturaAte && f.aberturaDe > f.aberturaAte) throw new ErroNegocio('A data inicial de abertura é maior que a final.');
  const chave = crypto.createHash('sha1').update(JSON.stringify({ prov: prov.id, f, pagina: p.pagina, limite: p.limite })).digest('hex');
  const salva = db.prepare('SELECT * FROM radar_buscas WHERE escritorio_id = ? AND chave = ?').get(escritorioId, chave) as any;
  const valida = salva && Date.now() - Date.parse(salva.criado_em.replace(' ', 'T') + 'Z') < cfg.cacheHoras * 3600e3;
  let total: number, cnpjs: string[], doCache = false, consultadoEm: string;
  if (valida && !p.atualizar) {
    total = salva.total; cnpjs = JSON.parse(salva.cnpjs_json); doCache = true; consultadoEm = salva.criado_em;
  } else {
    let r;
    try { r = await prov.pesquisar(f, p.pagina, p.limite); }
    catch (e) {
      auditar(escritorioId, usuarioId, 'ERRO_FONTE', null, String((e as Error).message));
      if (e instanceof ErroProvedor) throw new ErroNegocio(e.message, e.status >= 500 ? 502 : 400);
      throw e;
    }
    // a pesquisa da Casa dos Dados não filtra pela descrição da atividade: o filtro vale para a página trazida
    const atv = String(f.atividade ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const lista = atv && !prov.demonstracao ? r.empresas.filter((e) => String(e.cnae_descricao ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes(atv)) : r.empresas;
    db.transaction(() => {
      const visto = db.prepare('INSERT OR IGNORE INTO radar_vistos (escritorio_id, cnpj) VALUES (?, ?)');
      for (const e of lista) { guardarEmpresa(e, prov.id, prov.demonstracao); visto.run(escritorioId, e.cnpj); }
      db.prepare(`INSERT INTO radar_buscas (escritorio_id, chave, origem, total, cnpjs_json) VALUES (?,?,?,?,?)
        ON CONFLICT(escritorio_id, chave) DO UPDATE SET total = excluded.total, cnpjs_json = excluded.cnpjs_json, origem = excluded.origem, criado_em = datetime('now')`)
        .run(escritorioId, chave, prov.id, r.total, JSON.stringify(lista.map((e) => e.cnpj)));
    })();
    total = r.total; cnpjs = lista.map((e) => e.cnpj); consultadoEm = new Date().toISOString().replace('T', ' ').slice(0, 19);
    auditar(escritorioId, usuarioId, 'PESQUISA', null, `${prov.nome}: ${r.total} empresa(s), página ${p.pagina}${p.texto ? `, "${p.texto}"` : ''}${f.uf ? `, ${f.uf}` : ''}${f.municipio ? `/${f.municipio}` : ''}`);
  }
  const porCnpj = new Map((cnpjs.length ? db.prepare(`${SELECT_EMP} WHERE e.cnpj IN (${cnpjs.map(() => '?').join(',')})`).all(escritorioId, ...cnpjs) as any[] : []).map((r) => [r.cnpj, linhaEmpresa(r, criterios)]));
  let empresas = cnpjs.map((c) => porCnpj.get(c)).filter(Boolean) as any[];
  if (p.potencial) empresas = empresas.filter((e) => e.potencial.nivel === p.potencial);
  ordenar(empresas, p.ordem);
  return { modo: p.modo, fonte: prov.nome, demonstracao: prov.demonstracao, total, pagina: p.pagina, limite: p.limite, paginas: Math.max(1, Math.ceil(total / p.limite)), doCache, consultadoEm, empresas };
}

function ordenar(l: any[], ordem: Pesquisa['ordem']) {
  const PESO: Record<string, number> = { ALTO: 3, MEDIO: 2, BAIXO: 1 };
  l.sort((a, b) => ordem === 'NOME' ? String(a.nome_fantasia || a.razao_social).localeCompare(String(b.nome_fantasia || b.razao_social))
    : ordem === 'ANTIGAS' ? String(a.data_abertura ?? '').localeCompare(String(b.data_abertura ?? ''))
    : ordem === 'POTENCIAL' ? (PESO[b.potencial.nivel] ?? 0) - (PESO[a.potencial.nivel] ?? 0) || b.potencial.pontos - a.potencial.pontos
    : String(b.data_abertura ?? '').localeCompare(String(a.data_abertura ?? '')));
}

/** "Minha carteira": as empresas que o escritório adicionou como lead. */
function carteira(escritorioId: number, p: Pesquisa, criterios: Criterio[]) {
  const cond: string[] = ['l.escritorio_id = ?']; const par: any[] = [escritorioId];
  if (p.estagio && p.estagio in ESTAGIOS) { cond.push('l.estagio = ?'); par.push(p.estagio); }
  if (p.texto) { cond.push('(e.razao_social LIKE ? OR e.nome_fantasia LIKE ? OR e.cnpj LIKE ?)'); const t = `%${p.texto}%`; par.push(t, t, `%${so(p.texto) || '#'}%`); }
  if (p.uf) { cond.push('e.uf = ?'); par.push(p.uf.toUpperCase()); }
  if (p.municipio) { cond.push('e.municipio LIKE ?'); par.push(p.municipio); }
  if (p.cnae) { cond.push('e.cnae LIKE ?'); par.push(`${so(p.cnae)}%`); }
  const linhas = (db.prepare(`SELECT e.*, l.id AS lead_id, l.estagio AS lead_estagio, l.proximo_contato AS lead_proximo, u.nome AS lead_responsavel
    FROM radar_leads l JOIN radar_empresas e ON e.cnpj = l.cnpj LEFT JOIN usuarios u ON u.id = l.responsavel_id WHERE ${cond.join(' AND ')}`).all(...par) as any[]).map((r) => linhaEmpresa(r, criterios));
  let l = p.potencial ? linhas.filter((e) => e.potencial.nivel === p.potencial) : linhas;
  ordenar(l, p.ordem);
  const total = l.length;
  l = l.slice((p.pagina - 1) * p.limite, p.pagina * p.limite);
  return { modo: 'CARTEIRA', fonte: 'Carteira de prospecção', demonstracao: false, total, pagina: p.pagina, limite: p.limite, paginas: Math.max(1, Math.ceil(total / p.limite)), doCache: true, consultadoEm: null, empresas: l };
}

// ---------------------------------------------------------------------------------------------
// Detalhe e atualização de uma empresa
// ---------------------------------------------------------------------------------------------

function exigirVisivel(escritorioId: number, cnpj: string) {
  const ok = db.prepare('SELECT 1 FROM radar_vistos WHERE escritorio_id = ? AND cnpj = ? UNION SELECT 1 FROM radar_leads WHERE escritorio_id = ? AND cnpj = ?').get(escritorioId, cnpj, escritorioId, cnpj);
  if (!ok) throw new ErroNegocio('Empresa não encontrada no Radar deste escritório. Pesquise por ela primeiro.', 404);
}

export function detalheEmpresa(escritorioId: number, cnpjBruto: string) {
  const cnpj = so(cnpjBruto);
  exigirVisivel(escritorioId, cnpj);
  const r = db.prepare(`${SELECT_EMP} WHERE e.cnpj = ?`).get(escritorioId, cnpj) as any;
  if (!r) throw new ErroNegocio('Empresa não encontrada.', 404);
  const e = linhaEmpresa(r, configPublicaRadar(escritorioId).criterios);
  const alteracoes = (db.prepare('SELECT alteracoes_json FROM radar_empresas WHERE cnpj = ?').get(cnpj) as any)?.alteracoes_json;
  const lead: any = r.lead_id ? leadCompleto(escritorioId, r.lead_id) : null;
  const naCarteira = db.prepare('SELECT id, COALESCE(nome_fantasia, razao_social) AS nome FROM empresas WHERE escritorio_id = ? AND documento = ?').get(escritorioId, cnpj) ?? null;
  // lead convertido e cadastrado depois na carteira: liga os dois sozinho
  if (lead && !lead.empresa_id && naCarteira) { db.prepare('UPDATE radar_leads SET empresa_id = ? WHERE id = ?').run((naCarteira as any).id, lead.id); lead.empresa_id = (naCarteira as any).id; }
  // mudanças de campo vazio para preenchido (gravadas por versões anteriores) eram complemento, não alteração
  const historico = (alteracoes ? JSON.parse(alteracoes) : []).map((a: any) => ({ ...a, mudancas: a.mudancas
    .filter((m: any) => (m.campo === 'endereco' ? Object.keys(endLimpo(m.de)).length > 0 : !vazio(m.de) && !vazio(m.para)))
    .map((m: any) => ({ ...m, rotulo: ROTULO_CAMPO[m.campo] ?? m.campo })) })).filter((a: any) => a.mudancas.length);
  return { ...e, lead, alteracoes: historico, na_carteira: naCarteira };
}

export async function atualizarEmpresa(escritorioId: number, usuarioId: number, cnpjBruto: string) {
  const cnpj = so(cnpjBruto);
  exigirVisivel(escritorioId, cnpj);
  const prov = provedorDo(escritorioId);
  let e: EmpresaRadar | null;
  try { e = await prov.consultar(cnpj); }
  catch (er) { if (er instanceof ErroProvedor) throw new ErroNegocio(er.message, er.status >= 500 ? 502 : 400); throw er; }
  if (!e) throw new ErroNegocio('A fonte de dados não encontrou este CNPJ.', 404);
  const mud = guardarEmpresa(e, prov.id, prov.demonstracao);
  auditar(escritorioId, usuarioId, 'ATUALIZAR', cnpj, mud.length ? mud.map((m) => ROTULO_CAMPO[m.campo] ?? m.campo).join(', ') : 'sem mudanças');
  return { mudancas: mud.map((m) => ({ ...m, rotulo: ROTULO_CAMPO[m.campo] ?? m.campo })), empresa: detalheEmpresa(escritorioId, cnpj) };
}

/** Atualiza várias empresas pela consulta por CNPJ (uma consulta na fonte por empresa), uma de cada vez. */
export async function atualizarVarias(escritorioId: number, usuarioId: number, cnpjsBrutos: string[]) {
  const cnpjs = [...new Set(cnpjsBrutos.map(so))].filter((c) => c.length === 14);
  for (const c of cnpjs) exigirVisivel(escritorioId, c);
  const prov = provedorDo(escritorioId);
  const res: { cnpj: string; ok: boolean; mensagem: string | null; mudancas: number }[] = [];
  let parou: string | null = null;
  for (const cnpj of cnpjs) {
    if (parou) { res.push({ cnpj, ok: false, mensagem: 'Não consultada (a fonte de dados recusou as consultas anteriores).', mudancas: 0 }); continue; }
    try {
      const e = await prov.consultar(cnpj);
      if (!e) { res.push({ cnpj, ok: false, mensagem: 'A fonte de dados não encontrou este CNPJ.', mudancas: 0 }); continue; }
      const mud = guardarEmpresa(e, prov.id, prov.demonstracao);
      res.push({ cnpj, ok: true, mensagem: null, mudancas: mud.length });
    } catch (er) {
      if (!(er instanceof ErroProvedor)) throw er;
      res.push({ cnpj, ok: false, mensagem: er.message, mudancas: 0 });
      if ([401, 403, 429].includes(er.status)) parou = er.message; // chave, saldo ou limite: não adianta seguir
    }
  }
  const ok = res.filter((x) => x.ok).length;
  auditar(escritorioId, usuarioId, 'ATUALIZAR_LOTE', null, `${ok} de ${cnpjs.length} empresa(s) atualizada(s)${parou ? ` · interrompido: ${parou}` : ''}`);
  return { atualizadas: ok, falhas: res.length - ok, interrompido: parou, resultados: res };
}

// ---------------------------------------------------------------------------------------------
// CRM: leads e contatos
// ---------------------------------------------------------------------------------------------

export const NovoLead = z.object({
  cnpj: z.string().transform(so).refine((c) => c.length === 14, 'CNPJ inválido'),
  origem: z.enum(Object.keys(ORIGENS) as [keyof typeof ORIGENS]).default('RADAR'),
  responsavel_id: z.number().int().positive().nullish(),
  observacoes: z.string().trim().max(2000).nullish(),
});
export const EdicaoLead = z.object({
  estagio: z.enum(Object.keys(ESTAGIOS) as [Estagio]).optional(),
  responsavel_id: z.number().int().positive().nullable().optional(),
  origem: z.enum(Object.keys(ORIGENS) as [keyof typeof ORIGENS]).optional(),
  observacoes: z.string().trim().max(2000).nullable().optional(),
  proximo_contato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  motivo_perda: z.string().trim().max(500).nullable().optional(),
  empresa_id: z.number().int().positive().nullable().optional(),
  consentimento_contato: z.boolean().optional(),
});
export const NovoContato = z.object({
  quando: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
  canal: z.enum(Object.keys(CANAIS) as [keyof typeof CANAIS]),
  descricao: z.string().trim().min(3).max(2000),
  proximo_contato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
});

function lead(escritorioId: number, id: number) {
  const l = db.prepare('SELECT * FROM radar_leads WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!l) throw new ErroNegocio('Lead não encontrado.', 404);
  return l;
}
function conferirUsuario(escritorioId: number, id?: number | null) {
  if (id && !db.prepare('SELECT 1 FROM usuarios WHERE id = ? AND escritorio_id = ? AND ativo = 1').get(id, escritorioId)) throw new ErroNegocio('Responsável inválido.');
}
function leadCompleto(escritorioId: number, id: number) {
  const l = db.prepare(`SELECT l.*, u.nome AS responsavel, c.nome AS criado_por_nome, COALESCE(em.nome_fantasia, em.razao_social) AS empresa_nome
    FROM radar_leads l LEFT JOIN usuarios u ON u.id = l.responsavel_id LEFT JOIN usuarios c ON c.id = l.criado_por LEFT JOIN empresas em ON em.id = l.empresa_id
    WHERE l.id = ? AND l.escritorio_id = ?`).get(id, escritorioId) as any;
  if (!l) return null;
  const contatos = db.prepare(`SELECT k.id, k.quando, k.canal, k.descricao, k.criado_em, u.nome AS usuario FROM radar_contatos k LEFT JOIN usuarios u ON u.id = k.usuario_id
    WHERE k.lead_id = ? ORDER BY k.quando DESC, k.id DESC`).all(id);
  return { ...l, consentimento_contato: !!l.consentimento_contato, rotulo: ESTAGIOS[l.estagio as Estagio], contatos };
}

export function adicionarLead(escritorioId: number, usuarioId: number, d: z.infer<typeof NovoLead>) {
  exigirVisivel(escritorioId, d.cnpj);
  conferirUsuario(escritorioId, d.responsavel_id);
  const existe = db.prepare('SELECT id FROM radar_leads WHERE escritorio_id = ? AND cnpj = ?').get(escritorioId, d.cnpj) as any;
  if (existe) throw new ErroNegocio('Esta empresa já está na carteira de prospecção.', 409);
  const cliente = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND documento = ? AND na_carteira = 1').get(escritorioId, d.cnpj) as any;
  const id = Number(db.prepare('INSERT INTO radar_leads (escritorio_id, cnpj, origem, responsavel_id, observacoes, empresa_id, criado_por) VALUES (?,?,?,?,?,?,?)')
    .run(escritorioId, d.cnpj, d.origem, d.responsavel_id ?? usuarioId, d.observacoes ?? null, cliente?.id ?? null, usuarioId).lastInsertRowid);
  auditar(escritorioId, usuarioId, 'LEAD_NOVO', d.cnpj, ORIGENS[d.origem]);
  return leadCompleto(escritorioId, id);
}

export function editarLead(escritorioId: number, usuarioId: number, id: number, d: z.infer<typeof EdicaoLead>) {
  const atual = lead(escritorioId, id);
  if (d.responsavel_id !== undefined) conferirUsuario(escritorioId, d.responsavel_id);
  if (d.empresa_id) {
    const c = db.prepare('SELECT documento FROM empresas WHERE id = ? AND escritorio_id = ?').get(d.empresa_id, escritorioId) as any;
    if (!c) throw new ErroNegocio('Cliente não encontrado na carteira do escritório.');
  }
  const estagio = d.estagio ?? atual.estagio;
  const motivo = d.motivo_perda !== undefined ? d.motivo_perda : atual.motivo_perda;
  if (estagio === 'NAO_INTERESSADO' && !motivo) throw new ErroNegocio('Informe o motivo da perda para marcar como "Não interessado".');
  const sets: string[] = [], vals: any[] = [];
  const pôr = (c: string, v: any) => { sets.push(`${c} = ?`); vals.push(v); };
  for (const c of ['estagio', 'responsavel_id', 'origem', 'observacoes', 'proximo_contato', 'motivo_perda', 'empresa_id'] as const) if ((d as any)[c] !== undefined) pôr(c, (d as any)[c]);
  if (d.consentimento_contato !== undefined) { pôr('consentimento_contato', d.consentimento_contato ? 1 : 0); pôr('consentimento_em', d.consentimento_contato ? new Date().toISOString() : null); }
  if (d.estagio && d.estagio !== atual.estagio) pôr('convertido_em', d.estagio === 'CONVERTIDO' ? new Date().toISOString() : null);
  if (!sets.length) return leadCompleto(escritorioId, id);
  db.prepare(`UPDATE radar_leads SET ${sets.join(', ')}, atualizado_em = datetime('now') WHERE id = ? AND escritorio_id = ?`).run(...vals, id, escritorioId);
  if (d.estagio && d.estagio !== atual.estagio) auditar(escritorioId, usuarioId, 'ESTAGIO', atual.cnpj, `${ESTAGIOS[atual.estagio as Estagio]} → ${ESTAGIOS[d.estagio]}${d.estagio === 'NAO_INTERESSADO' ? ` (${motivo})` : ''}`);
  else auditar(escritorioId, usuarioId, 'LEAD_EDITADO', atual.cnpj, Object.keys(d).join(', '));
  return leadCompleto(escritorioId, id);
}

export function excluirLead(escritorioId: number, usuarioId: number, id: number) {
  const l = lead(escritorioId, id);
  db.prepare('DELETE FROM radar_leads WHERE id = ? AND escritorio_id = ?').run(id, escritorioId);
  auditar(escritorioId, usuarioId, 'LEAD_EXCLUIDO', l.cnpj, ESTAGIOS[l.estagio as Estagio]);
  return { ok: true };
}

export function registrarContato(escritorioId: number, usuarioId: number, leadId: number, d: z.infer<typeof NovoContato>) {
  const l = lead(escritorioId, leadId);
  db.prepare('INSERT INTO radar_contatos (lead_id, escritorio_id, quando, canal, descricao, usuario_id) VALUES (?,?,?,?,?,?)').run(leadId, escritorioId, d.quando, d.canal, d.descricao, usuarioId);
  // o primeiro contato tira o lead de "Novo"/"Não contatado"
  const estagio = ['NOVO', 'NAO_CONTATADO'].includes(l.estagio) ? 'PRIMEIRO_CONTATO' : l.estagio;
  db.prepare(`UPDATE radar_leads SET estagio = ?, proximo_contato = ?, atualizado_em = datetime('now') WHERE id = ?`).run(estagio, d.proximo_contato !== undefined ? d.proximo_contato : l.proximo_contato, leadId);
  auditar(escritorioId, usuarioId, 'CONTATO', l.cnpj, `${CANAIS[d.canal]}${estagio !== l.estagio ? ` · ${ESTAGIOS[estagio as Estagio]}` : ''}`);
  return leadCompleto(escritorioId, leadId);
}

/** Dados para o cadastro do lead convertido na Carteira de clientes (o usuário confere e completa o regime). */
export function sugestaoCadastro(escritorioId: number, leadId: number) {
  const l = lead(escritorioId, leadId);
  const e = db.prepare('SELECT * FROM radar_empresas WHERE cnpj = ?').get(l.cnpj) as any;
  if (e?.demonstracao) throw new ErroNegocio('Esta é uma empresa de demonstração: não pode ir para a carteira de clientes.');
  const end = e?.endereco_json ? JSON.parse(e.endereco_json) : {};
  return { documento: l.cnpj, razao_social: e?.razao_social, nome_fantasia: e?.nome_fantasia, cod_municipio: e?.cod_municipio, uf: e?.uf, cidade: e?.municipio, cnae: e?.cnae,
    email: e?.email, contato_fone: e?.telefone, cep: end.cep, logradouro: end.logradouro, numero: end.numero, complemento: end.complemento, bairro: end.bairro };
}

// ---------------------------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------------------------

export function painelRadar(escritorioId: number, dias = 30) {
  const hoje = hojeBr(), ini = somaDias(hoje, -dias), iniAnt = somaDias(hoje, -2 * dias);
  const um = (sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as any)?.n ?? 0;
  const identificadas = um('SELECT COUNT(*) AS n FROM radar_vistos WHERE escritorio_id = ?', escritorioId);
  const novos = um('SELECT COUNT(*) AS n FROM radar_vistos v JOIN radar_empresas e ON e.cnpj = v.cnpj WHERE v.escritorio_id = ? AND e.data_abertura >= ?', escritorioId, ini);
  const novosAnt = um('SELECT COUNT(*) AS n FROM radar_vistos v JOIN radar_empresas e ON e.cnpj = v.cnpj WHERE v.escritorio_id = ? AND e.data_abertura >= ? AND e.data_abertura < ?', escritorioId, iniAnt, ini);
  const leads = um(`SELECT COUNT(*) AS n FROM radar_leads WHERE escritorio_id = ? AND date(criado_em) >= ?`, escritorioId, ini);
  const leadsAnt = um(`SELECT COUNT(*) AS n FROM radar_leads WHERE escritorio_id = ? AND date(criado_em) >= ? AND date(criado_em) < ?`, escritorioId, iniAnt, ini);
  const porEstagio = Object.fromEntries(Object.keys(ESTAGIOS).map((k) => [k, 0])) as Record<Estagio, number>;
  for (const r of db.prepare('SELECT estagio, COUNT(*) AS n FROM radar_leads WHERE escritorio_id = ? GROUP BY estagio').all(escritorioId) as any[]) porEstagio[r.estagio as Estagio] = r.n;
  const totalLeads = Object.values(porEstagio).reduce((t, n) => t + n, 0);
  const convertidos = porEstagio.CONVERTIDO;
  const convertidosPeriodo = um(`SELECT COUNT(*) AS n FROM radar_leads WHERE escritorio_id = ? AND estagio = 'CONVERTIDO' AND date(convertido_em) >= ?`, escritorioId, ini);
  const encerrados = convertidos + porEstagio.NAO_INTERESSADO;
  const variacao = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
  const dist = (col: 'municipio' | 'cnae') => db.prepare(`SELECT ${col === 'municipio' ? "COALESCE(e.municipio || '/' || e.uf, '(sem município)')" : "COALESCE(e.cnae, '—')"} AS chave,
      ${col === 'cnae' ? 'MAX(e.cnae_descricao) AS descricao,' : ''} COUNT(*) AS n FROM radar_vistos v JOIN radar_empresas e ON e.cnpj = v.cnpj
    WHERE v.escritorio_id = ? GROUP BY chave ORDER BY n DESC LIMIT 8`).all(escritorioId);
  const proximos = db.prepare(`SELECT l.id, l.cnpj, l.proximo_contato, l.estagio, COALESCE(e.nome_fantasia, e.razao_social) AS nome, u.nome AS responsavel
    FROM radar_leads l JOIN radar_empresas e ON e.cnpj = l.cnpj LEFT JOIN usuarios u ON u.id = l.responsavel_id
    WHERE l.escritorio_id = ? AND l.proximo_contato IS NOT NULL AND l.proximo_contato <= ? AND l.estagio NOT IN ('CONVERTIDO','NAO_INTERESSADO') ORDER BY l.proximo_contato LIMIT 10`).all(escritorioId, somaDias(hoje, 7));
  return {
    dias, hoje,
    kpis: {
      identificadas, novos, novosVar: variacao(novos, novosAnt), leads, leadsVar: variacao(leads, leadsAnt), totalLeads,
      negociacao: porEstagio.EM_NEGOCIACAO, convertidos, convertidosPeriodo,
      conversao: encerrados ? Math.round((convertidos / totalLeads) * 100) : (totalLeads ? 0 : null),
    },
    porEstagio, porMunicipio: dist('municipio'), porCnae: dist('cnae'), proximos,
    config: configPublicaRadar(escritorioId),
  };
}
