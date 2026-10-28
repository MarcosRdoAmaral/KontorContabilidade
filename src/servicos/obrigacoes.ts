import { z } from 'zod';
import { db } from '../db.js';
import { diaUtil, motivoNaoUtil } from './diautil.js';
import { ErroNegocio } from './emissao.js';

/**
 * Obrigações e prazos do escritório.
 * O catálogo diz COMO calcular o vencimento de cada obrigação; as tarefas são geradas por cliente e competência
 * e guardam o andamento (pendente, em andamento, entregue, dispensada), quem fez e o protocolo.
 *
 * Vencimento = fim do período da competência + `meses_apos` meses, no dia dado pela regra:
 *   DIA_FIXO (dia X, ajustado por `ajuste` quando cai em fim de semana/feriado), ULTIMO_DIA_UTIL, DIA_UTIL_N (N-ésimo dia útil)
 *   ou DIA_UTIL_N_SABADO (N-ésimo dia útil contando os sábados, como no pagamento de salários).
 */

export const REGIMES = ['MEI', 'SIMPLES', 'PRESUMIDO', 'REAL', 'IMUNE', 'PF'] as const;
export type Regime = (typeof REGIMES)[number];
export const ROTULO_REGIME: Record<Regime, string> = { MEI: 'MEI', SIMPLES: 'Simples Nacional', PRESUMIDO: 'Lucro Presumido', REAL: 'Lucro Real', IMUNE: 'Imune / isenta', PF: 'Pessoa física' };

export const Obrigacao = z.object({
  codigo: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  nome: z.string().trim().min(2).max(120),
  esfera: z.enum(['FEDERAL', 'ESTADUAL', 'MUNICIPAL', 'TRABALHISTA', 'INTERNA']),
  periodicidade: z.enum(['MENSAL', 'TRIMESTRAL', 'ANUAL']),
  meses_apos: z.number().int().min(-11).max(24),
  regra: z.enum(['DIA_FIXO', 'ULTIMO_DIA_UTIL', 'DIA_UTIL_N', 'DIA_UTIL_N_SABADO']),
  dia: z.number().int().min(1).max(31).nullish(),
  ajuste: z.enum(['ANTECIPA', 'POSTERGA', 'MANTEM']).default('ANTECIPA'),
  regimes: z.array(z.enum(REGIMES)).default([]),
  requisito: z.enum(['FUNCIONARIOS', 'ICMS', 'ISS']).nullish(),
  aplica_padrao: z.boolean().default(true),
  antecedencia: z.number().int().min(0).max(60).default(5),
  ativa: z.boolean().default(true),
  observacoes: z.string().trim().max(500).nullish(),
}).refine((o) => o.regra === 'ULTIMO_DIA_UTIL' || !!o.dia, { path: ['dia'], message: 'Informe o dia' });
export type Obrigacao = z.infer<typeof Obrigacao>;

type Padrao = Omit<Obrigacao, 'ajuste' | 'regimes' | 'aplica_padrao' | 'antecedencia' | 'ativa'> & Partial<Obrigacao>;

/**
 * Catálogo inicial. Prazos conforme a legislação conhecida em 2026; o escritório pode (e deve) conferir
 * com a agenda tributária e ajustar aqui, porque normas mudam e há regras locais.
 */
export const CATALOGO_PADRAO: Padrao[] = [
  { codigo: 'DAS', nome: 'PGDAS-D e DAS (Simples Nacional)', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 20, ajuste: 'POSTERGA', regimes: ['SIMPLES'], observacoes: 'Vencimento no dia 20; sem expediente bancário, passa para o próximo dia útil.' },
  { codigo: 'DASMEI', nome: 'DAS do MEI', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 20, ajuste: 'POSTERGA', regimes: ['MEI'] },
  { codigo: 'DASNSIMEI', nome: 'DASN-SIMEI (declaração anual do MEI)', esfera: 'FEDERAL', periodicidade: 'ANUAL', meses_apos: 5, regra: 'DIA_FIXO', dia: 31, regimes: ['MEI'] },
  { codigo: 'DEFIS', nome: 'DEFIS (Simples Nacional)', esfera: 'FEDERAL', periodicidade: 'ANUAL', meses_apos: 3, regra: 'DIA_FIXO', dia: 31, regimes: ['SIMPLES'] },
  { codigo: 'ESOCIAL', nome: 'eSocial — eventos periódicos (folha)', esfera: 'TRABALHISTA', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 15, requisito: 'FUNCIONARIOS' },
  { codigo: 'FOLHA', nome: 'Pagamento de salários (5º dia útil)', esfera: 'TRABALHISTA', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_UTIL_N_SABADO', dia: 5, requisito: 'FUNCIONARIOS', antecedencia: 3, observacoes: 'Para o pagamento de salários o sábado conta como dia útil.' },
  { codigo: 'FGTS', nome: 'FGTS Digital (guia)', esfera: 'TRABALHISTA', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 20, requisito: 'FUNCIONARIOS' },
  { codigo: 'REINF', nome: 'EFD-Reinf', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 15, regimes: ['SIMPLES', 'PRESUMIDO', 'REAL', 'IMUNE'], aplica_padrao: false, observacoes: 'Quando houver retenções, serviços tomados com cessão de mão de obra, CPRB etc.' },
  { codigo: 'DCTFWEB', nome: 'DCTFWeb', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'ULTIMO_DIA_UTIL', requisito: 'FUNCIONARIOS', observacoes: 'Com movimento de folha ou retenções (eSocial/Reinf). Guia DARF previdenciária: dia 20.' },
  { codigo: 'DARFPREV', nome: 'DARF previdenciário (DCTFWeb)', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 20, requisito: 'FUNCIONARIOS', regimes: ['PRESUMIDO', 'REAL', 'IMUNE'] },
  { codigo: 'PISCOFINS', nome: 'PIS e COFINS (DARF)', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 25, regimes: ['PRESUMIDO', 'REAL'] },
  { codigo: 'EFDCONTRIB', nome: 'EFD-Contribuições', esfera: 'FEDERAL', periodicidade: 'MENSAL', meses_apos: 2, regra: 'DIA_UTIL_N', dia: 10, regimes: ['PRESUMIDO', 'REAL'] },
  { codigo: 'IRPJCSLL', nome: 'IRPJ e CSLL trimestrais', esfera: 'FEDERAL', periodicidade: 'TRIMESTRAL', meses_apos: 1, regra: 'ULTIMO_DIA_UTIL', regimes: ['PRESUMIDO', 'REAL'] },
  { codigo: 'ECD', nome: 'ECD (escrituração contábil digital)', esfera: 'FEDERAL', periodicidade: 'ANUAL', meses_apos: 6, regra: 'ULTIMO_DIA_UTIL', regimes: ['PRESUMIDO', 'REAL', 'IMUNE'] },
  { codigo: 'ECF', nome: 'ECF (escrituração contábil fiscal)', esfera: 'FEDERAL', periodicidade: 'ANUAL', meses_apos: 7, regra: 'ULTIMO_DIA_UTIL', regimes: ['PRESUMIDO', 'REAL', 'IMUNE'] },
  { codigo: 'EFDICMS', nome: 'EFD ICMS/IPI', esfera: 'ESTADUAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 20, regimes: ['PRESUMIDO', 'REAL'], requisito: 'ICMS', observacoes: 'Santa Catarina: dia 20. Confira o prazo do seu estado.' },
  { codigo: 'DESTDA', nome: 'DeSTDA (Simples com ICMS-ST/DIFAL)', esfera: 'ESTADUAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 28, regimes: ['SIMPLES'], requisito: 'ICMS', aplica_padrao: false },
  { codigo: 'ISS', nome: 'ISS próprio (guia municipal)', esfera: 'MUNICIPAL', periodicidade: 'MENSAL', meses_apos: 1, regra: 'DIA_FIXO', dia: 10, regimes: ['PRESUMIDO', 'REAL'], requisito: 'ISS', observacoes: 'Prazo varia por município: ajuste conforme a lei local.' },
  { codigo: 'DMED', nome: 'DMED (serviços de saúde)', esfera: 'FEDERAL', periodicidade: 'ANUAL', meses_apos: 2, regra: 'ULTIMO_DIA_UTIL', aplica_padrao: false },
  { codigo: '13SAL1', nome: '13º salário — 1ª parcela', esfera: 'TRABALHISTA', periodicidade: 'ANUAL', meses_apos: -1, regra: 'DIA_FIXO', dia: 30, requisito: 'FUNCIONARIOS' },
  { codigo: '13SAL2', nome: '13º salário — 2ª parcela', esfera: 'TRABALHISTA', periodicidade: 'ANUAL', meses_apos: 0, regra: 'DIA_FIXO', dia: 20, requisito: 'FUNCIONARIOS' },
];

const P_INICIO = (escritorioId: number) => `obrigacoes_inicio:${escritorioId}`;

/**
 * Data a partir da qual o escritório controla os prazos no sistema (padrão: o 1º dia do mês do primeiro uso).
 * Vencimentos anteriores não geram tarefas, para não encher a lista de "atrasadas" que foram entregues fora do sistema.
 */
export function inicioDoControle(escritorioId: number): string {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(P_INICIO(escritorioId)) as any)?.valor;
  if (v) return v;
  const ini = `${new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7)}-01`;
  db.prepare('INSERT OR IGNORE INTO parametros (nome, valor) VALUES (?, ?)').run(P_INICIO(escritorioId), ini);
  return ini;
}

export function definirInicioDoControle(escritorioId: number, data: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroNegocio('Data inválida.');
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(P_INICIO(escritorioId), data);
}

/** Cria o catálogo padrão do escritório na primeira vez (obrigações já existentes não são tocadas). */
export function garantirCatalogo(escritorioId: number) {
  inicioDoControle(escritorioId);
  const ins = db.prepare(`INSERT OR IGNORE INTO obrigacoes (escritorio_id, codigo, nome, esfera, periodicidade, meses_apos, regra, dia, ajuste, regimes, requisito, aplica_padrao, antecedencia, ativa, observacoes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of CATALOGO_PADRAO) {
    const o = Obrigacao.parse(p);
    ins.run(escritorioId, o.codigo, o.nome, o.esfera, o.periodicidade, o.meses_apos, o.regra, o.dia ?? null, o.ajuste, JSON.stringify(o.regimes), o.requisito ?? null, o.aplica_padrao ? 1 : 0, o.antecedencia, o.ativa ? 1 : 0, o.observacoes ?? null);
  }
}

// ---------------------------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------------------------

const ultimoDiaMes = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate(); // m: 1..12
const ymd = (a: number, m: number, d: number) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function somarMeses(a: number, m: number, n: number): [number, number] {
  const t = a * 12 + (m - 1) + n;
  return [Math.floor(t / 12), (t % 12) + 1];
}

/** Último mês (ano, mês 1..12) do período da competência. */
export function fimDoPeriodo(periodicidade: string, competencia: string): [number, number] {
  if (periodicidade === 'MENSAL') { const [a, m] = competencia.split('-').map(Number); return [a, m]; }
  if (periodicidade === 'TRIMESTRAL') { const [a, t] = competencia.split('-T').map(Number); return [a, t * 3]; }
  return [Number(competencia), 12];
}

/** Data de vencimento da obrigação para a competência. */
export function vencimento(o: Pick<Obrigacao, 'periodicidade' | 'meses_apos' | 'regra' | 'dia' | 'ajuste'>, competencia: string, extras?: string | null): string {
  const [af, mf] = fimDoPeriodo(o.periodicidade, competencia);
  const [a, m] = somarMeses(af, mf, o.meses_apos);
  const ultimo = ultimoDiaMes(a, m);
  if (o.regra === 'ULTIMO_DIA_UTIL') return diaUtil(ymd(a, m, ultimo), -1, extras);
  if (o.regra === 'DIA_UTIL_N' || o.regra === 'DIA_UTIL_N_SABADO') {
    const sabado = o.regra === 'DIA_UTIL_N_SABADO';
    const util = (d: string) => { const mt = motivoNaoUtil(d, extras); return !mt || (sabado && mt === 'sábado'); };
    let t = Date.UTC(a, m - 1, 1), achados = 0;
    for (let i = 0; i < 40; i++, t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (util(d) && ++achados === (o.dia ?? 1)) return d;
    }
  }
  const data = ymd(a, m, Math.min(o.dia ?? 1, ultimo));
  if (o.ajuste === 'MANTEM' || !motivoNaoUtil(data, extras)) return data;
  return diaUtil(data, o.ajuste === 'POSTERGA' ? 1 : -1, extras);
}

/** Competências cujo vencimento pode cair no mês (AAAA-MM). */
export function competenciasCandidatas(periodicidade: string, meses_apos: number, mes: string): string[] {
  const [a, m] = mes.split('-').map(Number);
  // o fim do período fica por volta de (mês − meses_apos); olha um mês para cada lado por causa dos ajustes de dia útil
  const saida = new Set<string>();
  for (const delta of [-1, 0, 1]) {
    const [af, mf] = somarMeses(a, m, -meses_apos + delta);
    if (periodicidade === 'MENSAL') saida.add(`${af}-${String(mf).padStart(2, '0')}`);
    else if (periodicidade === 'TRIMESTRAL') { if (mf % 3 === 0) saida.add(`${af}-T${mf / 3}`); }
    else if (mf === 12) saida.add(String(af));
  }
  return [...saida];
}

export function rotuloCompetencia(c: string) {
  if (/^\d{4}-\d{2}$/.test(c)) return `${c.slice(5)}/${c.slice(0, 4)}`;
  if (/^\d{4}-T\d$/.test(c)) return `${c.slice(6)}º tri/${c.slice(0, 4)}`;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Aplicabilidade e geração
// ---------------------------------------------------------------------------------------------

interface LinhaObrigacao { id: number; codigo: string; nome: string; esfera: string; periodicidade: string; meses_apos: number; regra: string; dia: number | null; ajuste: string; regimes: string; requisito: string | null; aplica_padrao: number; antecedencia: number; ativa: number; observacoes: string | null }
interface LinhaCliente { id: number; regime: string | null; op_simp_nac: number; tem_funcionarios: number; contribuinte_icms: number; contribuinte_iss: number; situacao: string; cliente_desde: string | null; encerrado_em: string | null; feriados_extra: string | null; responsavel_id: number | null; eh_escritorio: number }

/** Regime efetivo: o informado na carteira ou, na falta dele, o deduzido da opção pelo Simples do cadastro de emissão. */
export const regimeDe = (e: { regime: string | null; op_simp_nac: number }): Regime | null =>
  (e.regime as Regime) ?? (e.op_simp_nac === 2 ? 'MEI' : e.op_simp_nac === 3 ? 'SIMPLES' : null);

/** A obrigação vale para o cliente pela regra padrão (regime e requisito)? */
export function aplicaPorPadrao(o: Pick<LinhaObrigacao, 'regimes' | 'requisito' | 'aplica_padrao'>, c: Pick<LinhaCliente, 'regime' | 'op_simp_nac' | 'tem_funcionarios' | 'contribuinte_icms' | 'contribuinte_iss'>): boolean {
  if (!o.aplica_padrao) return false;
  const regimes = JSON.parse(o.regimes || '[]') as string[];
  const r = regimeDe(c);
  if (regimes.length && (!r || !regimes.includes(r))) return false;
  if (o.requisito === 'FUNCIONARIOS' && !c.tem_funcionarios) return false;
  if (o.requisito === 'ICMS' && !c.contribuinte_icms) return false;
  if (o.requisito === 'ISS' && !c.contribuinte_iss) return false;
  return true;
}

/** O cliente já era (ou ainda é) atendido no período da competência? */
function ativoNoPeriodo(c: LinhaCliente, o: LinhaObrigacao, competencia: string): boolean {
  if (c.eh_escritorio) return false;
  const [af, mf] = fimDoPeriodo(o.periodicidade, competencia);
  const fim = ymd(af, mf, ultimoDiaMes(af, mf));
  const inicioPeriodo = o.periodicidade === 'MENSAL' ? ymd(af, mf, 1) : o.periodicidade === 'TRIMESTRAL' ? ymd(af, mf - 2, 1) : ymd(af, 1, 1);
  if (c.cliente_desde && c.cliente_desde > fim) return false;
  if (c.situacao === 'ENCERRADO' && (!c.encerrado_em || c.encerrado_em < inicioPeriodo)) return false;
  return c.situacao !== 'SUSPENSO';
}

/** Gera (sem duplicar) as tarefas com vencimento no mês, para todos os clientes do escritório. Retorna quantas criou. */
export function gerarTarefas(escritorioId: number, mes: string): number {
  garantirCatalogo(escritorioId);
  const obrig = db.prepare('SELECT * FROM obrigacoes WHERE escritorio_id = ? AND ativa = 1').all(escritorioId) as LinhaObrigacao[];
  const clientes = db.prepare(`SELECT id, regime, op_simp_nac, tem_funcionarios, contribuinte_icms, contribuinte_iss, situacao, cliente_desde, encerrado_em, feriados_extra, responsavel_id, eh_escritorio
    FROM empresas WHERE escritorio_id = ? AND na_carteira = 1`).all(escritorioId) as LinhaCliente[];
  const excecoes = new Map<string, { aplica: number; responsavel_id: number | null }>();
  for (const x of db.prepare(`SELECT eo.* FROM empresa_obrigacoes eo JOIN empresas e ON e.id = eo.empresa_id WHERE e.escritorio_id = ?`).all(escritorioId) as any[]) excecoes.set(`${x.empresa_id}:${x.obrigacao_id}`, x);
  const ins = db.prepare('INSERT OR IGNORE INTO tarefas (empresa_id, obrigacao_id, competencia, vencimento, responsavel_id) VALUES (?,?,?,?,?)');
  const inicio = inicioDoControle(escritorioId);
  if (`${mes}-31` < inicio) return 0;
  let criadas = 0;
  db.transaction(() => {
    for (const c of clientes) {
      for (const o of obrig) {
        const ex = excecoes.get(`${c.id}:${o.id}`);
        const aplica = ex && ex.aplica != null ? !!ex.aplica : aplicaPorPadrao(o, c);
        if (!aplica) continue;
        for (const comp of competenciasCandidatas(o.periodicidade, o.meses_apos, mes)) {
          const venc = vencimento(o as any, comp, c.feriados_extra);
          if (venc.slice(0, 7) !== mes || venc < inicio || !ativoNoPeriodo(c, o, comp)) continue;
          criadas += Number(ins.run(c.id, o.id, comp, venc, ex?.responsavel_id ?? c.responsavel_id ?? null).changes);
        }
      }
    }
  })();
  return criadas;
}

/**
 * Remove tarefas ainda PENDENTES (sem nenhum andamento) que deixaram de se aplicar ao cliente
 * — por exemplo, depois de trocar o regime ou dispensar a obrigação. Tarefas com andamento ficam.
 */
export function limparTarefasQueNaoSeAplicam(empresaId: number) {
  const c = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as LinhaCliente | undefined;
  if (!c) return;
  const pend = db.prepare(`SELECT t.id, t.obrigacao_id, t.competencia, o.periodicidade, o.regimes, o.requisito, o.aplica_padrao FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id
    WHERE t.empresa_id = ? AND t.status = 'PENDENTE' AND t.protocolo IS NULL AND t.observacao IS NULL AND t.vencimento >= date('now','-3 hours')`).all(empresaId) as any[];
  for (const t of pend) {
    const ex = db.prepare('SELECT aplica FROM empresa_obrigacoes WHERE empresa_id = ? AND obrigacao_id = ?').get(empresaId, t.obrigacao_id) as any;
    const aplica = ex && ex.aplica != null ? !!ex.aplica : aplicaPorPadrao(t, c);
    if (!aplica || !ativoNoPeriodo(c, t, t.competencia)) db.prepare('DELETE FROM tarefas WHERE id = ?').run(t.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Consulta e andamento
// ---------------------------------------------------------------------------------------------

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

export type Prazo = 'ENTREGUE' | 'DISPENSADA' | 'ATRASADA' | 'HOJE' | 'EM_BREVE' | 'NO_PRAZO';
export function situacaoPrazo(t: { status: string; vencimento: string; antecedencia: number }, hoje = hojeBr()): Prazo {
  if (t.status === 'ENTREGUE') return 'ENTREGUE';
  if (t.status === 'DISPENSADA') return 'DISPENSADA';
  if (t.vencimento < hoje) return 'ATRASADA';
  if (t.vencimento === hoje) return 'HOJE';
  const dias = (Date.parse(t.vencimento) - Date.parse(hoje)) / 864e5;
  return dias <= t.antecedencia ? 'EM_BREVE' : 'NO_PRAZO';
}

export interface FiltroTarefas { mes?: string; empresaId?: number; responsavelId?: number; atrasadas?: boolean; empresas?: number[] | null }

/** Tarefas do mês (gera as que faltam) e, se pedido, todas as atrasadas de meses anteriores. */
export function listarTarefas(escritorioId: number, f: FiltroTarefas, hoje = hojeBr()) {
  const cond: string[] = ['e.escritorio_id = ?'];
  const p: any[] = [escritorioId];
  if (f.mes) {
    gerarTarefas(escritorioId, f.mes);
    if (f.atrasadas) { cond.push(`(substr(t.vencimento,1,7) = ? OR (t.vencimento < ? AND t.status IN ('PENDENTE','ANDAMENTO')))`); p.push(f.mes, hoje); }
    else { cond.push('substr(t.vencimento,1,7) = ?'); p.push(f.mes); }
  } else if (f.atrasadas) { cond.push(`t.vencimento < ? AND t.status IN ('PENDENTE','ANDAMENTO')`); p.push(hoje); }
  if (f.empresaId) { cond.push('t.empresa_id = ?'); p.push(f.empresaId); }
  if (f.responsavelId) { cond.push('t.responsavel_id = ?'); p.push(f.responsavelId); }
  if (f.empresas) { cond.push(`t.empresa_id IN (${f.empresas.map(() => '?').join(',') || 'NULL'})`); p.push(...f.empresas); }
  const linhas = db.prepare(`SELECT t.*, o.codigo, o.nome AS obrigacao, o.esfera, o.periodicidade, o.antecedencia, o.observacoes AS obs_obrigacao,
      COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.regime, e.op_simp_nac,
      r.nome AS responsavel, ep.nome AS entregue_por_nome
    FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id JOIN empresas e ON e.id = t.empresa_id
    LEFT JOIN usuarios r ON r.id = t.responsavel_id LEFT JOIN usuarios ep ON ep.id = t.entregue_por
    WHERE ${cond.join(' AND ')} ORDER BY t.vencimento, cliente, o.codigo`).all(...p) as any[];
  return linhas.map((t) => ({ ...t, competencia_rotulo: rotuloCompetencia(t.competencia), prazo: situacaoPrazo(t, hoje) }));
}

export function resumoTarefas(lista: { prazo: Prazo }[]) {
  const r = { total: lista.length, entregues: 0, dispensadas: 0, atrasadas: 0, hoje: 0, em_breve: 0, no_prazo: 0 };
  for (const t of lista) {
    if (t.prazo === 'ENTREGUE') r.entregues++; else if (t.prazo === 'DISPENSADA') r.dispensadas++; else if (t.prazo === 'ATRASADA') r.atrasadas++;
    else if (t.prazo === 'HOJE') r.hoje++; else if (t.prazo === 'EM_BREVE') r.em_breve++; else r.no_prazo++;
  }
  return r;
}

export const AndamentoTarefa = z.object({
  status: z.enum(['PENDENTE', 'ANDAMENTO', 'ENTREGUE', 'DISPENSADA']),
  responsavel_id: z.number().int().positive().nullish(),
  protocolo: z.string().trim().max(120).nullish(),
  observacao: z.string().trim().max(1000).nullish(),
  entregue_em: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export function atualizarTarefa(escritorioId: number, usuarioId: number, id: number, d: z.infer<typeof AndamentoTarefa>) {
  const t = db.prepare('SELECT t.* FROM tarefas t JOIN empresas e ON e.id = t.empresa_id WHERE t.id = ? AND e.escritorio_id = ?').get(id, escritorioId) as any;
  if (!t) throw new ErroNegocio('Tarefa não encontrada.', 404);
  if (d.status === 'DISPENSADA' && !d.observacao) throw new ErroNegocio('Informe o motivo da dispensa (ex.: sem movimento, não se aplica neste mês).');
  if (d.responsavel_id && !db.prepare('SELECT 1 FROM usuarios WHERE id = ? AND escritorio_id = ?').get(d.responsavel_id, escritorioId)) throw new ErroNegocio('Responsável inválido.');
  const entregue = d.status === 'ENTREGUE';
  db.prepare(`UPDATE tarefas SET status = ?, responsavel_id = ?, protocolo = ?, observacao = ?, entregue_em = ?, entregue_por = ?, atualizada_em = datetime('now') WHERE id = ?`)
    .run(d.status, d.responsavel_id ?? null, d.protocolo || null, d.observacao || null,
      entregue ? (d.entregue_em ?? t.entregue_em ?? hojeBr()) : null, entregue ? (t.entregue_por ?? usuarioId) : null, id);
}

/** Marca várias tarefas como entregues de uma vez (mantém protocolo/observação de cada uma). */
export function entregarEmLote(escritorioId: number, usuarioId: number, ids: number[]) {
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      n += Number(db.prepare(`UPDATE tarefas SET status = 'ENTREGUE', entregue_em = COALESCE(entregue_em, ?), entregue_por = COALESCE(entregue_por, ?), atualizada_em = datetime('now')
        WHERE id = ? AND status IN ('PENDENTE','ANDAMENTO') AND empresa_id IN (SELECT id FROM empresas WHERE escritorio_id = ?)`).run(hojeBr(), usuarioId, id, escritorioId).changes);
    }
  })();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Catálogo (CRUD) e exceções por cliente
// ---------------------------------------------------------------------------------------------

export function listarObrigacoes(escritorioId: number) {
  garantirCatalogo(escritorioId);
  return (db.prepare('SELECT * FROM obrigacoes WHERE escritorio_id = ? ORDER BY ativa DESC, esfera, nome').all(escritorioId) as LinhaObrigacao[])
    .map((o) => ({ ...o, regimes: JSON.parse(o.regimes || '[]'), aplica_padrao: !!o.aplica_padrao, ativa: !!o.ativa, exemplo: vencimento(o as any, competenciaExemplo(o.periodicidade, o.meses_apos)) }));
}

/** Uma competência cujo vencimento cai no futuro próximo, para mostrar um exemplo de data no catálogo. */
function competenciaExemplo(periodicidade: string, meses_apos: number) {
  const mes = hojeBr().slice(0, 7);
  for (let k = 0; k < 14; k++) {
    const [a, m] = somarMeses(+mes.slice(0, 4), +mes.slice(5), k);
    const c = competenciasCandidatas(periodicidade, meses_apos, `${a}-${String(m).padStart(2, '0')}`)[1] ?? competenciasCandidatas(periodicidade, meses_apos, `${a}-${String(m).padStart(2, '0')}`)[0];
    if (c) return c;
  }
  return mes;
}

export function salvarObrigacao(escritorioId: number, id: number | null, d: Obrigacao) {
  const campos = [d.codigo, d.nome, d.esfera, d.periodicidade, d.meses_apos, d.regra, d.regra === 'ULTIMO_DIA_UTIL' ? null : d.dia ?? null, d.ajuste, JSON.stringify(d.regimes), d.requisito ?? null, d.aplica_padrao ? 1 : 0, d.antecedencia, d.ativa ? 1 : 0, d.observacoes ?? null];
  if (id == null) {
    return Number(db.prepare(`INSERT INTO obrigacoes (codigo, nome, esfera, periodicidade, meses_apos, regra, dia, ajuste, regimes, requisito, aplica_padrao, antecedencia, ativa, observacoes, escritorio_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...campos, escritorioId).lastInsertRowid);
  }
  const r = db.prepare(`UPDATE obrigacoes SET codigo=?, nome=?, esfera=?, periodicidade=?, meses_apos=?, regra=?, dia=?, ajuste=?, regimes=?, requisito=?, aplica_padrao=?, antecedencia=?, ativa=?, observacoes=?
    WHERE id = ? AND escritorio_id = ?`).run(...campos, id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Obrigação não encontrada.', 404);
  // recalcula os vencimentos das tarefas ainda abertas (as entregues guardam a data que valia)
  const abertas = db.prepare(`SELECT t.id, t.competencia, e.feriados_extra FROM tarefas t JOIN empresas e ON e.id = t.empresa_id WHERE t.obrigacao_id = ? AND t.status IN ('PENDENTE','ANDAMENTO')`).all(id) as any[];
  for (const t of abertas) db.prepare('UPDATE tarefas SET vencimento = ? WHERE id = ?').run(vencimento(d, t.competencia, t.feriados_extra), t.id);
  return id;
}

export function excluirObrigacao(escritorioId: number, id: number) {
  const usada = db.prepare(`SELECT COUNT(*) AS n FROM tarefas WHERE obrigacao_id = ? AND status IN ('ENTREGUE','ANDAMENTO')`).get(id) as { n: number };
  if (usada.n) throw new ErroNegocio('Esta obrigação já tem entregas registradas. Desative-a em vez de excluir, para manter o histórico.');
  const r = db.prepare('DELETE FROM obrigacoes WHERE id = ? AND escritorio_id = ?').run(id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Obrigação não encontrada.', 404);
}

/** Obrigações do cliente: cada uma com a regra padrão, a exceção (se houver) e o resultado. */
export function obrigacoesDoCliente(escritorioId: number, empresaId: number) {
  garantirCatalogo(escritorioId);
  const c = db.prepare('SELECT * FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as LinhaCliente | undefined;
  if (!c) throw new ErroNegocio('Cliente não encontrado.', 404);
  const obrig = db.prepare('SELECT * FROM obrigacoes WHERE escritorio_id = ? AND ativa = 1 ORDER BY esfera, nome').all(escritorioId) as LinhaObrigacao[];
  return obrig.map((o) => {
    const ex = db.prepare('SELECT aplica, responsavel_id FROM empresa_obrigacoes WHERE empresa_id = ? AND obrigacao_id = ?').get(empresaId, o.id) as any;
    const padrao = aplicaPorPadrao(o, c);
    const temEx = ex && ex.aplica != null;
    return { obrigacao_id: o.id, codigo: o.codigo, nome: o.nome, esfera: o.esfera, padrao, excecao: temEx ? (ex.aplica ? 'FORCA' : 'DISPENSA') : null, aplica: temEx ? !!ex.aplica : padrao, responsavel_id: ex?.responsavel_id ?? null };
  });
}

export const ExcecoesCliente = z.array(z.object({
  obrigacao_id: z.number().int().positive(),
  excecao: z.enum(['FORCA', 'DISPENSA']).nullable(),
  responsavel_id: z.number().int().positive().nullish(),
}));

export function salvarObrigacoesDoCliente(escritorioId: number, empresaId: number, itens: z.infer<typeof ExcecoesCliente>) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  db.transaction(() => {
    for (const i of itens) {
      if (!db.prepare('SELECT 1 FROM obrigacoes WHERE id = ? AND escritorio_id = ?').get(i.obrigacao_id, escritorioId)) continue;
      if (!i.excecao && !i.responsavel_id) { db.prepare('DELETE FROM empresa_obrigacoes WHERE empresa_id = ? AND obrigacao_id = ?').run(empresaId, i.obrigacao_id); continue; }
      const aplica = i.excecao ? (i.excecao === 'FORCA' ? 1 : 0) : null;
      db.prepare(`INSERT INTO empresa_obrigacoes (empresa_id, obrigacao_id, aplica, responsavel_id) VALUES (?,?,?,?)
        ON CONFLICT(empresa_id, obrigacao_id) DO UPDATE SET aplica = excluded.aplica, responsavel_id = excluded.responsavel_id`).run(empresaId, i.obrigacao_id, aplica, i.responsavel_id ?? null);
      if (i.responsavel_id) db.prepare(`UPDATE tarefas SET responsavel_id = ? WHERE empresa_id = ? AND obrigacao_id = ? AND status IN ('PENDENTE','ANDAMENTO')`).run(i.responsavel_id, empresaId, i.obrigacao_id);
    }
  })();
  limparTarefasQueNaoSeAplicam(empresaId);
}
