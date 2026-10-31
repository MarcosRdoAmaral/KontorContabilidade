import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { situacaoPrazo } from './obrigacoes.js';
import { ultimasCaixas, ultimosParcelamentos } from './parcelamentos-caixa.js';

/**
 * Monitor fiscal: situação de cada cliente da carteira por processo (PGDAS-D, PGMEI, DCTFWeb, FGTS Digital,
 * situação fiscal na Receita/PGFN, certificados e procurações, demais obrigações), notificações e sublimites do
 * Simples (RBT12). E o resumo financeiro de um cliente pelos XML capturados (receita, custos, lucro bruto).
 * Tudo é lido do que o sistema já guarda; nada consulta a Receita aqui.
 */

export type Estado = 'EM_DIA' | 'PENDENTE' | 'ATENCAO' | 'PROCESSANDO';
const PESO: Record<Estado, number> = { EM_DIA: 0, PROCESSANDO: 1, PENDENTE: 2, ATENCAO: 3 };
const pior = (l: (Estado | null)[]): Estado | null => l.filter(Boolean).reduce<Estado | null>((a, b) => (!a || PESO[b!] > PESO[a] ? b : a), null);

export const PROCESSOS = [
  { id: 'PGDAS', nome: 'PGDAS-D' },
  { id: 'PGMEI', nome: 'PGMEI' },
  { id: 'DCTFWEB', nome: 'DCTFWeb' },
  { id: 'FGTS', nome: 'FGTS Digital' },
  { id: 'SITFIS', nome: 'Situação fiscal' },
  { id: 'PARC', nome: 'Parcelamentos' },
  { id: 'CAIXA', nome: 'Caixa postal' },
  { id: 'CERT', nome: 'Certificados' },
  { id: 'OBRIG', nome: 'Demais obrigações' },
] as const;
type Proc = (typeof PROCESSOS)[number]['id'];
const CODIGOS: Partial<Record<Proc, string[]>> = { PGDAS: ['DAS'], PGMEI: ['DASMEI'], DCTFWEB: ['DCTFWEB', 'DARFPREV'] };
const DE_PROCESSO = new Set(Object.values(CODIGOS).flat());

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const fimDoMes = (mes: string) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
const mesesAntes = (mes: string, n: number) => { const [a, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(a, m - 1 - n, 1)); return d.toISOString().slice(0, 7); };

type Notif = { nivel: Estado; processo: Proc; empresa_id: number; cliente: string; titulo: string; texto: string; data: string };

export function monitorFiscal(escritorioId: number, empresas: number[] | null = null) {
  const hoje = hojeBr(), mes = hoje.slice(0, 7), ate = fimDoMes(mes);
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  const clientes = db.prepare(`SELECT e.id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.regime, e.tem_funcionarios, e.cert_validade, (e.cert_pfx_enc IS NOT NULL) AS tem_a1
    FROM empresas e WHERE e.escritorio_id = ? AND e.na_carteira = 1 AND e.eh_escritorio = 0 AND e.situacao = 'ATIVO' ${filtro} ORDER BY cliente`).all(escritorioId, ...(empresas ?? [])) as any[];
  const ids = clientes.map((c) => c.id);
  const em = ids.length ? ids.join(',') : 'NULL';

  // obrigações vencidas ou que vencem até o fim deste mês (dispensadas não contam)
  const tarefas = db.prepare(`SELECT t.empresa_id, t.status, t.vencimento, t.competencia, o.codigo, o.nome, o.antecedencia FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id
    WHERE t.empresa_id IN (${em}) AND t.vencimento <= ? AND t.status != 'DISPENSADA'`).all(ate) as any[];
  const porEmpresa = new Map<number, any[]>();
  for (const t of tarefas) { const l = porEmpresa.get(t.empresa_id) ?? []; l.push({ ...t, prazo: situacaoPrazo(t, hoje) }); porEmpresa.set(t.empresa_id, l); }
  const estadoTarefas = (l: any[]): Estado | null => {
    if (!l.length) return null;
    if (l.some((t) => t.prazo === 'ATRASADA')) return 'ATENCAO';
    if (l.some((t) => t.prazo !== 'ENTREGUE')) return 'PENDENTE';
    return 'EM_DIA';
  };
  const ultimo = (sql: string) => new Map((db.prepare(sql).all() as any[]).map((r) => [r.empresa_id, r]));
  const fgts = ultimo(`SELECT f.* FROM fgts_consultas f WHERE f.id IN (SELECT MAX(id) FROM fgts_consultas WHERE empresa_id IN (${em}) GROUP BY empresa_id)`);
  const sit = ultimo(`SELECT s.id, s.empresa_id, s.status, s.situacao, s.qtd_pendencias, s.total_aberto, s.erro, s.solicitada_em, s.concluida_em FROM situacao_fiscal s
    WHERE s.id IN (SELECT MAX(id) FROM situacao_fiscal WHERE empresa_id IN (${em}) GROUP BY empresa_id)`);
  const fech = db.prepare(`SELECT empresa_id, tipo, situacao, erro, competencia, atualizado_em FROM fechamentos WHERE empresa_id IN (${em}) AND competencia >= ?`).all(mesesAntes(mes, 2)) as any[];
  const parcs = ultimosParcelamentos(ids), caixas = ultimasCaixas(ids);
  const certs = db.prepare(`SELECT empresa_id, tipo, titular, validade FROM certificados WHERE escritorio_id = ? AND renovado = 0 AND empresa_id IN (${em})`).all(escritorioId) as any[];

  const notificacoes: Notif[] = [];
  const linhas = clientes.map((c) => {
    const n = (nivel: Estado, processo: Proc, titulo: string, texto: string, data: string) => notificacoes.push({ nivel, processo, empresa_id: c.id, cliente: c.cliente, titulo, texto, data });
    const tl = porEmpresa.get(c.id) ?? [];
    const proc: Record<Proc, Estado | null> = {} as any;
    for (const p of ['PGDAS', 'PGMEI', 'DCTFWEB'] as Proc[]) proc[p] = estadoTarefas(tl.filter((t) => CODIGOS[p]!.includes(t.codigo)));
    proc.OBRIG = estadoTarefas(tl.filter((t) => !DE_PROCESSO.has(t.codigo)));
    for (const t of tl.filter((t) => t.prazo === 'ATRASADA')) {
      const p: Proc = CODIGOS.PGDAS!.includes(t.codigo) ? 'PGDAS' : CODIGOS.PGMEI!.includes(t.codigo) ? 'PGMEI' : CODIGOS.DCTFWEB!.includes(t.codigo) ? 'DCTFWEB' : 'OBRIG';
      n('ATENCAO', p, `${t.nome} atrasada`, `Competência ${t.competencia}, venceu em ${t.vencimento.split('-').reverse().join('/')}.`, t.vencimento);
    }
    for (const f of fech.filter((x) => x.empresa_id === c.id)) {
      const p: Proc = f.tipo === 'PGDASD' ? 'PGDAS' : 'DCTFWEB';
      if (f.situacao === 'ERRO') { proc[p] = pior([proc[p], 'ATENCAO']); n('ATENCAO', p, `${f.tipo === 'PGDASD' ? 'PGDAS-D' : 'DCTFWeb'} com erro na transmissão`, f.erro ?? 'A Receita recusou a transmissão.', f.atualizado_em.slice(0, 10)); }
      else if (f.situacao === 'CALCULADO') proc[p] = pior([proc[p], 'PROCESSANDO']);
    }
    const fg = fgts.get(c.id);
    proc.FGTS = !fg ? null : fg.situacao === 'EM_DIA' ? 'EM_DIA' : fg.situacao === 'EM_ABERTO' ? 'ATENCAO' : 'PENDENTE';
    if (fg && fg.situacao !== 'EM_DIA') n(proc.FGTS!, 'FGTS', fg.situacao === 'EM_ABERTO' ? `FGTS Digital: ${fg.qtd_competencias} competência(s) em aberto` : fg.situacao === 'SEM_PROCURACAO' ? 'FGTS Digital: sem procuração' : 'FGTS Digital: erro na consulta',
      fg.situacao === 'EM_ABERTO' ? `Total em aberto ${Number(fg.total ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.` : (fg.mensagem ?? ''), fg.consultado_em.slice(0, 10));
    const s = sit.get(c.id);
    proc.SITFIS = !s ? null : s.status === 'SOLICITADA' ? 'PROCESSANDO' : s.status === 'ERRO' ? 'PENDENTE' : s.situacao === 'REGULAR' ? 'EM_DIA' : s.situacao === 'PENDENCIAS' ? 'ATENCAO' : 'PENDENTE';
    if (s && proc.SITFIS !== 'EM_DIA' && proc.SITFIS !== 'PROCESSANDO') n(proc.SITFIS!, 'SITFIS', s.status === 'ERRO' ? 'Situação fiscal: erro na consulta' : s.situacao === 'PENDENCIAS' ? `Situação fiscal: ${s.qtd_pendencias ?? ''} pendência(s)` : 'Situação fiscal: verificar o relatório',
      s.status === 'ERRO' ? (s.erro ?? '') : s.total_aberto ? `Em aberto ${Number(s.total_aberto).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} na Receita/PGFN.` : 'Confira o relatório da Receita/PGFN.', (s.concluida_em ?? s.solicitada_em).slice(0, 10));
    const pc = parcs.get(c.id);
    proc.PARC = !pc ? null : pc.situacao === 'EM_ATRASO' ? 'ATENCAO' : pc.situacao === 'EM_DIA' || pc.situacao === 'SEM_PARCELAMENTO' ? 'EM_DIA' : 'PENDENTE';
    if (pc && proc.PARC !== 'EM_DIA') n(proc.PARC!, 'PARC', pc.situacao === 'EM_ATRASO' ? `Parcelamento com ${pc.qtd_atrasadas} parcela(s) em atraso` : pc.situacao === 'SEM_PROCURACAO' ? 'Parcelamentos: sem procuração' : 'Parcelamentos: erro na consulta',
      pc.situacao === 'EM_ATRASO' ? `Em atraso ${Number(pc.valor_atrasado ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.` : (pc.erro ?? ''), pc.consultado_em.slice(0, 10));
    const cx = caixas.get(c.id);
    proc.CAIXA = !cx ? null : cx.situacao !== 'OK' ? 'PENDENTE' : cx.relevantes ? 'ATENCAO' : cx.nao_lidas ? 'PENDENTE' : 'EM_DIA';
    if (cx && cx.situacao !== 'OK') n('PENDENTE', 'CAIXA', cx.situacao === 'SEM_PROCURACAO' ? 'Caixa postal: sem procuração' : 'Caixa postal: erro na consulta', cx.erro ?? '', cx.consultado_em.slice(0, 10));
    for (const m of (cx?.mensagens ?? []).filter((m: any) => !m.lida).slice(0, 5)) n(m.relevante ? 'ATENCAO' : 'PENDENTE', 'CAIXA', `Caixa postal: ${m.assunto || 'mensagem não lida'}`, `${m.origem ? `${m.origem}. ` : ''}Não lida${m.relevante ? ', marcada como relevante pela Receita' : ''}.`, m.enviada_em ?? cx.consultado_em.slice(0, 10));
    // certificados: o A1 enviado ao sistema e os cadastrados em Certificados (inclui procurações)
    const validades = [...certs.filter((x) => x.empresa_id === c.id).map((x) => ({ nome: x.tipo === 'PROCURACAO' ? 'Procuração' : `Certificado ${x.tipo}`, validade: x.validade })),
      ...(c.tem_a1 && c.cert_validade ? [{ nome: 'Certificado A1', validade: String(c.cert_validade).slice(0, 10) }] : [])];
    proc.CERT = pior(validades.map((v) => (v.validade < hoje ? 'ATENCAO' : v.validade <= somaDias(hoje, 30) ? 'PENDENTE' : 'EM_DIA')));
    for (const v of validades) if (v.validade <= somaDias(hoje, 30)) n(v.validade < hoje ? 'ATENCAO' : 'PENDENTE', 'CERT', `${v.nome}: ${v.validade < hoje ? 'validade vencida' : 'vence em breve'}`, `Validade ${v.validade.split('-').reverse().join('/')}.`, v.validade < hoje ? v.validade : hoje);
    return { empresa_id: c.id, cliente: c.cliente, documento: c.documento, regime: c.regime, processos: proc,
      parc_consultado: pc?.consultado_em ?? null, caixa_consultada: cx?.consultado_em ?? null, nao_lidas: cx?.nao_lidas ?? null, geral: pior(Object.values(proc)) };
  });

  /** null = sem informação (processo que não se aplica ao cliente ou nunca consultado). */
  const contar = (l: (Estado | null)[]) => ({
    ...Object.fromEntries((['EM_DIA', 'PENDENTE', 'ATENCAO', 'PROCESSANDO'] as Estado[]).map((e) => [e, l.filter((x) => x === e).length])), SEM_DADOS: l.filter((x) => !x).length });
  const subl = sublimites(ids);
  for (const x of subl.clientes) if (x.situacao !== 'EM_DIA')
    notificacoes.push({ nivel: x.situacao, processo: 'PGDAS', empresa_id: x.empresa_id, cliente: x.cliente, titulo: x.situacao === 'ATENCAO' ? 'Sublimite do Simples ultrapassado' : 'Perto do sublimite do Simples',
      texto: `Faturamento acumulado em ${x.competencia.slice(0, 4)}: ${x.acumulado.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} (até ${x.competencia.slice(5)}/${x.competencia.slice(0, 4)}). ${x.motivo}`, data: hoje });
  notificacoes.sort((a, b) => PESO[b.nivel] - PESO[a.nivel] || b.data.localeCompare(a.data));
  return {
    atualizado_em: new Date().toISOString(),
    total: linhas.length,
    geral: contar(linhas.map((l) => l.geral)),
    processos: PROCESSOS.map((p) => ({ ...p, contagem: contar(linhas.map((l) => l.processos[p.id])) })),
    clientes: linhas,
    notificacoes: notificacoes.slice(0, 300),
    sublimites: subl,
  };
}

// ---------------------------------------------------------------------------------------------
// Receitas e custos pelos documentos capturados (e pelo faturamento do controle mensal)
// ---------------------------------------------------------------------------------------------

/** Operações que não são compra nem venda (remessas, devoluções, transferências...): ficam fora da receita e dos custos. */
const NAO_OPERACAO = /remessa|retorno|devolu|transfer|bonifica|brinde|amostra|demonstra|comodato|conserto|consigna|garantia/i;
const natOp = (xml: string | null) => (xml ? /<natOp>([^<]*)<\/natOp>/.exec(xml)?.[1] ?? '' : '');

type Mov = { mes: string; receita_nfe: number; receita_nfse: number; custo_nfe: number; custo_nfse: number; xml_nfe_saida: number; xml_nfe_entrada: number; xml_nfse: number; fora: number };

/** Movimento mês a mês de um cliente entre dois meses (AAAA-MM, inclusive). */
export function movimentoMensal(escritorioId: number, empresaId: number, de: string, ate: string): Mov[] {
  const e = db.prepare('SELECT id, documento, ambiente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const d0 = `${de}-01`, d1 = fimDoMes(ate);
  const meses: string[] = []; for (let m = de; m <= ate; m = mesesAntes(m, -1)) meses.push(m);
  const r = new Map<string, Mov>(meses.map((m) => [m, { mes: m, receita_nfe: 0, receita_nfse: 0, custo_nfe: 0, custo_nfse: 0, xml_nfe_saida: 0, xml_nfe_entrada: 0, xml_nfse: 0, fora: 0 }]));
  const em = (data: string | null) => (data ? r.get(data.slice(0, 7)) : undefined);
  for (const s of db.prepare(`SELECT emissao, valor, natureza, situacao FROM nfe_saidas WHERE escritorio_id = ? AND emitente_documento = ? AND xml IS NOT NULL AND substr(emissao,1,10) BETWEEN ? AND ?`).all(escritorioId, e.documento, d0, d1) as any[]) {
    const m = em(s.emissao); if (!m) continue;
    m.xml_nfe_saida++;
    if (s.situacao !== 'AUTORIZADA') continue;
    if (NAO_OPERACAO.test(s.natureza ?? '')) m.fora++; else m.receita_nfe += s.valor ?? 0;
  }
  for (const c of db.prepare(`SELECT emissao, valor, xml, situacao FROM nfe_recebidas WHERE empresa_id = ? AND oculta = 0 AND substr(emissao,1,10) BETWEEN ? AND ?`).all(empresaId, d0, d1) as any[]) {
    const m = em(c.emissao); if (!m) continue;
    if (c.xml) m.xml_nfe_entrada++;
    if (c.situacao !== 'AUTORIZADA') continue;
    if (NAO_OPERACAO.test(natOp(c.xml))) m.fora++; else m.custo_nfe += c.valor ?? 0;
  }
  for (const n of db.prepare(`SELECT papel, competencia, valor, situacao, xml FROM nfse_capturadas WHERE empresa_id = ? AND papel IN ('PRESTADOR','TOMADOR') AND substr(competencia,1,10) BETWEEN ? AND ?`).all(empresaId, d0, d1) as any[]) {
    const m = em(n.competencia); if (!m) continue;
    if (n.xml) m.xml_nfse++;
    if (n.situacao !== 'AUTORIZADA') continue;
    if (n.papel === 'PRESTADOR') m.receita_nfse += n.valor ?? 0; else m.custo_nfse += n.valor ?? 0;
  }
  // NFS-e emitidas pelo próprio Kontor e ainda não capturadas do Ambiente Nacional
  for (const n of db.prepare(`SELECT competencia, valor_servico FROM notas n WHERE n.empresa_id = ? AND n.ambiente = ? AND n.status = 'AUTORIZADA' AND substr(n.competencia,1,10) BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM nfse_capturadas c WHERE c.empresa_id = n.empresa_id AND c.chave = n.chave_acesso)`).all(empresaId, e.ambiente, d0, d1) as any[]) {
    const m = em(n.competencia); if (m) { m.receita_nfse += n.valor_servico ?? 0; m.xml_nfse++; }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [...r.values()].map((m) => ({ ...m, receita_nfe: r2(m.receita_nfe), receita_nfse: r2(m.receita_nfse), custo_nfe: r2(m.custo_nfe), custo_nfse: r2(m.custo_nfse) }));
}

/**
 * Faturamento acumulado dos clientes do Simples, pelas declarações do PGDAS-D guardadas no Kontor (a mais recente de
 * cada cliente): acumulado no ano (RBA + receita do mês da declaração), RBT12 e a projeção até dezembro no ritmo do ano.
 * Sublimite de R$ 3,6 milhões (ICMS e ISS fora do DAS) e limite de R$ 4,8 milhões do Simples.
 */
export const SUBLIMITE = 3_600_000, LIMITE_SN = 4_800_000;
function sublimites(ids: number[]) {
  const ano = hojeBr().slice(0, 4);
  const simples = ids.length ? (db.prepare(`SELECT id, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id IN (${ids.join(',')}) AND regime = 'SIMPLES'`).all() as any[]) : [];
  const clientes: any[] = [];
  let semDeclaracao = 0;
  for (const c of simples) {
    const r = db.prepare('SELECT competencia, rpa, rbt12, rba FROM pgdas_receitas WHERE empresa_id = ? AND (rpa IS NOT NULL OR rba IS NOT NULL) ORDER BY competencia DESC LIMIT 1').get(c.id) as any;
    if (!r) { semDeclaracao++; continue; }
    const doAno = r.competencia.slice(0, 4) === ano;
    const acumulado = Math.round(((r.rba ?? 0) + (r.rpa ?? 0)) * 100) / 100;
    const meses = Number(r.competencia.slice(5));
    const projecao = doAno && meses ? Math.round((acumulado / meses) * 12 * 100) / 100 : null;
    let situacao: Estado = 'EM_DIA', motivo = 'Dentro do sublimite.';
    if (acumulado > LIMITE_SN) { situacao = 'ATENCAO'; motivo = 'Passou do limite de R$ 4,8 milhões do Simples Nacional.'; }
    else if (acumulado > SUBLIMITE * 1.2) { situacao = 'ATENCAO'; motivo = 'Passou do sublimite em mais de 20%: ICMS e ISS fora do DAS já a partir do mês seguinte.'; }
    else if (acumulado > SUBLIMITE) { situacao = 'ATENCAO'; motivo = 'Passou do sublimite: ICMS e ISS fora do DAS a partir de janeiro do ano que vem.'; }
    else if (acumulado >= SUBLIMITE * 0.8) { situacao = 'PENDENTE'; motivo = `Já usou ${Math.round((acumulado / SUBLIMITE) * 100)}% do sublimite no ano.`; }
    else if (projecao != null && projecao > SUBLIMITE) { situacao = 'PENDENTE'; motivo = 'No ritmo do ano, passa do sublimite até dezembro.'; }
    clientes.push({ empresa_id: c.id, cliente: c.cliente, competencia: r.competencia, do_ano: doAno, acumulado, rbt12: r.rbt12, rpa: r.rpa, projecao, situacao, motivo });
  }
  const ordem: Record<string, number> = { ATENCAO: 0, PENDENTE: 1, EM_DIA: 2 };
  clientes.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || b.acumulado - a.acumulado);
  return { ano, sublimite: SUBLIMITE, limite: LIMITE_SN, clientes, sem_declaracao: semDeclaracao };
}

/** Resumo financeiro de um cliente: o mês escolhido e os 12 meses até ele. */
export function resumoFinanceiro(escritorioId: number, empresaId: number, mes: string) {
  const serie = movimentoMensal(escritorioId, empresaId, mesesAntes(mes, 11), mes);
  const atual = serie[serie.length - 1];
  const receita = atual.receita_nfe + atual.receita_nfse, custo = atual.custo_nfe + atual.custo_nfse;
  const c = db.prepare('SELECT COALESCE(nome_fantasia, razao_social) AS cliente, documento, regime FROM empresas WHERE id = ?').get(empresaId) as any;
  const ultima = db.prepare(`SELECT MAX(x) AS u FROM (SELECT MAX(recebida_em) AS x FROM nfe_recebidas WHERE empresa_id = ? UNION ALL SELECT MAX(recebida_em) FROM nfse_capturadas WHERE empresa_id = ?
    UNION ALL SELECT MAX(recebida_em) FROM nfe_saidas WHERE escritorio_id = ? AND emitente_documento = ?)`).get(empresaId, empresaId, escritorioId, c.documento) as any;
  return {
    cliente: c.cliente, documento: c.documento, regime: c.regime, mes, ultima_captura: ultima?.u ?? null,
    kpis: { xmls: atual.xml_nfe_saida + atual.xml_nfe_entrada + atual.xml_nfse, receita, custo, lucro: Math.round((receita - custo) * 100) / 100, margem: receita ? (receita - custo) / receita : null, fora: atual.fora },
    atual, serie,
  };
}
