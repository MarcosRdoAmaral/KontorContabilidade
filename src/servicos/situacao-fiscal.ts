import { z } from 'zod';
import { db } from '../db.js';
import { enviarEmailSimples } from './email.js';
import { ErroNegocio } from './emissao.js';
import { Integra, lerConfig, semProcuracao, textoMsgs, type Transporte } from './integra-contador.js';

/**
 * Situação fiscal do cliente: o Relatório de Situação Fiscal da Receita Federal e da PGFN (o mesmo do e-CAC),
 * pedido pelo Integra Contador em dois passos: Apoiar/SOLICITARPROTOCOLO91 devolve um protocolo e o tempo de espera;
 * Emitir/RELATORIOSITFIS92 devolve o PDF quando ele fica pronto. O PDF é guardado e o texto é lido para listar
 * o que está em aberto (débitos, omissões de declaração, inscrições em dívida ativa).
 */

const ESPERA_MAX_MS = 25_000;      // quanto o sistema espera, na mesma consulta, o relatório ficar pronto
const PROTOCOLO_VALIDO_MS = 12 * 3600e3;

// ---------------------------------------------------------------------------------------------
// Leitura do relatório
// ---------------------------------------------------------------------------------------------

export interface ItemPendencia { texto: string; receita?: string | null; descricao?: string | null; periodo?: string | null; vencimento?: string | null; valorOriginal?: number | null; saldo?: number | null; situacao?: string | null }
export interface SecaoRelatorio { titulo: string; tipo: 'PENDENCIA' | 'SUSPENSO'; itens: ItemPendencia[] }
export interface RelatorioLido { situacao: 'REGULAR' | 'PENDENCIAS' | 'VERIFICAR'; secoes: SecaoRelatorio[]; totalAberto: number; qtdPendencias: number; certidao: string | null }

const MOEDA = /\d{1,3}(?:\.\d{3})*,\d{2}/g;
const num = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
const LIXO = [
  /^p[áa]gina\s+\d+/i, /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(:\d{2})?$/, /^minist[ée]rio da/i, /^secretaria especial/i, /^receita federal do brasil$/i,
  /^procuradoria-geral da fazenda nacional$/i, /^informa[çc][õo]es de apoio/i, /^por meio do e-cac/i, /^emitido em/i, /^relat[óo]rio de situa[çc][ãa]o fiscal/i,
];
const CABECALHO = [/^receita\s+pa\/?exerc/i, /sdo\.?\s*devedor/i, /^inscri[çc][ãa]o\s+receita/i, /^cnpj:\s*[\d./-]+$/i, /^cpf:\s*[\d.-]+$/i, /^(cnpj|cpf)\s*[\d./-]+$/i];

/** Interpreta o texto do relatório (uma linha por linha do PDF). */
export function lerRelatorio(texto: string): RelatorioLido {
  const linhas = texto.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const secoes: SecaoRelatorio[] = [];
  let atual: SecaoRelatorio | null = null;
  const semPendencia = /n[ãa]o foram detectadas pend[êe]ncias/i.test(texto);
  const certidao = texto.match(/certid[ãa]o emitida[\s\S]{0,40}?(positiva com efeitos de negativa|positiva|negativa)/i)?.[1] ?? null;
  for (const l of linhas) {
    const pend = /^pend[êe]ncia\s*[-–]\s*(.+)$/i.exec(l);
    if (pend) { atual = { titulo: pend[1].trim(), tipo: 'PENDENCIA', itens: [] }; secoes.push(atual); continue; }
    if (/^d[ée]bito com exigibilidade suspensa/i.test(l)) { atual = { titulo: l, tipo: 'SUSPENSO', itens: [] }; secoes.push(atual); continue; }
    if (/^(diagn[óo]stico fiscal|final do relat[óo]rio|dados cadastrais|certid[ãa]o emitida|s[óo]cios e administradores|n[ãa]o foram detectadas)/i.test(l)) { atual = null; continue; }
    if (!atual || LIXO.some((r) => r.test(l)) || CABECALHO.some((r) => r.test(l))) continue;
    const item: ItemPendencia = { texto: l };
    // débito: "1082-01 - CP-SEGURADOS 06/2023 20/07/2023 1.234,56 1.234,56 ... DEVEDOR"
    const deb = /^(\d{4}-\d{2})\s*-\s*(.+?)\s+((?:\d{1,2}[ºo°]?\s*TRIM\/\d{4})|(?:\d{2}\/\d{4})|(?:\d{2}\/\d{2}\/\d{4})|(?:\d{4}))\s+(\d{2}\/\d{2}\/\d{4})\s+(.*)$/i.exec(l);
    if (deb) {
      const valores = deb[5].match(MOEDA) ?? [];
      Object.assign(item, {
        receita: deb[1], descricao: deb[2].trim(), periodo: deb[3], vencimento: deb[4].split('/').reverse().join('-'),
        valorOriginal: valores[0] ? num(valores[0]) : null, saldo: valores.length ? num(valores[valores.length - 1]) : null,
        situacao: deb[5].replace(MOEDA, '').trim() || null,
      });
    } else {
      const valores = l.match(MOEDA) ?? [];
      if (valores.length) item.saldo = num(valores[valores.length - 1]);
    }
    atual.itens.push(item);
  }
  const pendentes = secoes.filter((s) => s.tipo === 'PENDENCIA');
  const qtd = pendentes.reduce((n, s) => n + Math.max(1, s.itens.length), 0);
  const total = Math.round(pendentes.flatMap((s) => s.itens).reduce((t, i) => t + (i.saldo ?? 0), 0) * 100) / 100;
  const situacao = pendentes.length ? 'PENDENCIAS' : semPendencia ? 'REGULAR' : 'VERIFICAR';
  return { situacao, secoes, totalAberto: total, qtdPendencias: pendentes.length ? qtd : 0, certidao };
}

/** Texto do PDF, linha a linha (agrupa os pedaços de texto pela altura). */
export async function textoDoPdf(pdf: Buffer): Promise<string> {
  // @ts-ignore — build "legacy" do pdf.js roda em Node sem navegador
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, useSystemFonts: false }).promise;
  const saida: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const itens = (await pg.getTextContent()).items.filter((i: any) => i.str !== undefined && String(i.str).trim() !== '')
      .map((i: any) => ({ x: i.transform[4], y: i.transform[5], s: String(i.str) }));
    const linhas: { y: number; it: { x: number; s: string }[] }[] = [];
    for (const it of [...itens].sort((a, b) => b.y - a.y)) {
      const l = linhas.find((k) => Math.abs(k.y - it.y) < 2.5);
      l ? l.it.push(it) : linhas.push({ y: it.y, it: [it] });
    }
    for (const l of linhas) saida.push(l.it.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim());
  }
  return saida.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------------------------

type Espera = (ms: number) => Promise<void>;
const dormir: Espera = (ms) => new Promise((r) => setTimeout(r, ms));

function ultimaPendente(empresaId: number) {
  return db.prepare(`SELECT * FROM situacao_fiscal WHERE empresa_id = ? AND status = 'SOLICITADA' AND protocolo IS NOT NULL ORDER BY id DESC LIMIT 1`).get(empresaId) as any;
}

async function concluir(id: number, pdf: Buffer) {
  let texto = '';
  try { texto = await textoDoPdf(pdf); } catch { /* PDF guardado mesmo sem leitura */ }
  const r = texto ? lerRelatorio(texto) : { situacao: 'VERIFICAR' as const, secoes: [], totalAberto: 0, qtdPendencias: 0, certidao: null };
  db.prepare(`UPDATE situacao_fiscal SET status = 'PRONTA', situacao = ?, resumo_json = ?, total_aberto = ?, qtd_pendencias = ?, pdf = ?, texto = ?, erro = NULL, concluida_em = datetime('now') WHERE id = ?`)
    .run(r.situacao, JSON.stringify(r), r.totalAberto, r.qtdPendencias, pdf, texto, id);
  return r;
}

export interface ResultadoSitfis { empresa_id: number; cliente: string; status: 'PRONTA' | 'SOLICITADA' | 'ERRO'; situacao?: string; mensagem: string; id?: number }

/** Pede (ou retoma) o relatório de um cliente e espera um pouco por ele. */
export async function consultarSituacao(escritorioId: number, usuarioId: number | null, empresaId: number, opcoes: { transporte?: Transporte; esperar?: Espera } = {}): Promise<ResultadoSitfis> {
  const e = db.prepare('SELECT id, documento, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (!opcoes.transporte && lerConfig(escritorioId)?.ambiente === 'DEMONSTRACAO') throw new ErroNegocio('O Integra Contador está no ambiente de Demonstração. Troque para Produção em Configurações > Integra Contador.');
  const esperar = opcoes.esperar ?? dormir;
  const i = Integra.para(escritorioId, opcoes.transporte);
  const base = { empresa_id: e.id, cliente: e.cliente };
  let reg = ultimaPendente(empresaId);
  if (reg && Date.now() - Date.parse(reg.solicitada_em.replace(' ', 'T') + 'Z') > PROTOCOLO_VALIDO_MS) reg = null;
  if (!reg) {
    const r = await i.consultar(e.documento, 'SITFIS', 'SOLICITARPROTOCOLO91', null, 'Apoiar');
    const protocolo = r.dados?.protocoloRelatorio ?? r.dados?.protocolo ?? null;
    if (!r.ok || !protocolo) {
      const msg = semProcuracao(r.mensagens) ? 'Sem procuração do cliente para o escritório no e-CAC.' : textoMsgs(r.mensagens) || `O SERPRO não devolveu o protocolo (HTTP ${r.http}).`;
      const id = Number(db.prepare(`INSERT INTO situacao_fiscal (empresa_id, status, erro, usuario_id, concluida_em) VALUES (?, 'ERRO', ?, ?, datetime('now'))`).run(empresaId, msg, usuarioId).lastInsertRowid);
      return { ...base, status: 'ERRO', mensagem: msg, id };
    }
    const espera = Number(r.dados?.tempoEspera ?? r.dados?.tempoEsperaMs) || 0;
    const id = Number(db.prepare(`INSERT INTO situacao_fiscal (empresa_id, status, protocolo, liberar_em, usuario_id) VALUES (?, 'SOLICITADA', ?, ?, ?)`)
      .run(empresaId, String(protocolo), new Date(Date.now() + espera).toISOString(), usuarioId).lastInsertRowid);
    reg = db.prepare('SELECT * FROM situacao_fiscal WHERE id = ?').get(id);
    if (espera > 0) await esperar(Math.min(espera, ESPERA_MAX_MS));
  }
  let gasto = 0;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await i.consultar(e.documento, 'SITFIS', 'RELATORIOSITFIS92', { protocoloRelatorio: reg.protocolo }, 'Emitir');
    const pdf64 = r.dados?.pdf ?? r.dados?.pdfBase64 ?? r.dados?.relatorio ?? (typeof r.dados === 'string' && r.dados.startsWith('JVBER') ? r.dados : null);
    if (r.ok && pdf64) {
      const lido = await concluir(reg.id, Buffer.from(String(pdf64), 'base64'));
      const msg = lido.situacao === 'REGULAR' ? 'Sem pendências na Receita Federal e na PGFN.' : lido.situacao === 'PENDENCIAS' ? `${lido.qtdPendencias} pendência(s)${lido.totalAberto ? `, saldo de R$ ${lido.totalAberto.toFixed(2).replace('.', ',')}` : ''}.` : 'Relatório recebido: confira o PDF.';
      return { ...base, status: 'PRONTA', situacao: lido.situacao, mensagem: msg, id: reg.id };
    }
    const espera = Number(r.dados?.tempoEspera ?? r.dados?.tempoEsperaMs) || 0;
    if (espera > 0 && gasto + espera <= ESPERA_MAX_MS) {
      db.prepare('UPDATE situacao_fiscal SET liberar_em = ? WHERE id = ?').run(new Date(Date.now() + espera).toISOString(), reg.id);
      gasto += espera; await esperar(espera); continue;
    }
    if (espera > 0) {
      db.prepare('UPDATE situacao_fiscal SET liberar_em = ? WHERE id = ?').run(new Date(Date.now() + espera).toISOString(), reg.id);
      return { ...base, status: 'SOLICITADA', mensagem: `A Receita ainda está gerando o relatório. Clique em Atualizar daqui a ${Math.ceil(espera / 1000)} segundo(s).`, id: reg.id };
    }
    const msg = semProcuracao(r.mensagens) ? 'Sem procuração do cliente para o escritório no e-CAC.' : textoMsgs(r.mensagens) || `Falha ao emitir o relatório (HTTP ${r.http}).`;
    db.prepare(`UPDATE situacao_fiscal SET status = 'ERRO', erro = ?, concluida_em = datetime('now') WHERE id = ?`).run(msg, reg.id);
    return { ...base, status: 'ERRO', mensagem: msg, id: reg.id };
  }
  return { ...base, status: 'SOLICITADA', mensagem: 'A Receita ainda está gerando o relatório. Clique em Atualizar em instantes.', id: reg.id };
}

export async function consultarVarios(escritorioId: number, usuarioId: number | null, ids: number[], opcoes: { transporte?: Transporte; esperar?: Espera } = {}) {
  const resultados: ResultadoSitfis[] = [];
  for (const id of ids.slice(0, 100)) {
    try { resultados.push(await consultarSituacao(escritorioId, usuarioId, id, opcoes)); }
    catch (e: any) {
      const c = db.prepare('SELECT COALESCE(nome_fantasia, razao_social) AS n FROM empresas WHERE id = ?').get(id) as any;
      resultados.push({ empresa_id: id, cliente: c?.n ?? String(id), status: 'ERRO', mensagem: String(e?.message ?? e) });
      if (e instanceof ErroNegocio && /autentica|Consumer|certificado A1|Configure|Demonstra/.test(e.message)) break;
    }
  }
  return { consultados: resultados.length, prontos: resultados.filter((r) => r.status === 'PRONTA').length, comPendencias: resultados.filter((r) => r.situacao === 'PENDENCIAS').length,
    aguardando: resultados.filter((r) => r.status === 'SOLICITADA').length, erros: resultados.filter((r) => r.status === 'ERRO').length, resultados };
}

/** Carteira com a última situação fiscal de cada cliente. */
export function painelSituacao(escritorioId: number, empresas: number[] | null = null) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  return (db.prepare(`SELECT e.id AS empresa_id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.regime, e.op_simp_nac, u.nome AS responsavel,
      s.id, s.status, s.situacao, s.total_aberto, s.qtd_pendencias, s.erro, s.liberar_em, s.solicitada_em, s.concluida_em, (s.pdf IS NOT NULL) AS tem_pdf
    FROM empresas e LEFT JOIN usuarios u ON u.id = e.responsavel_id
    LEFT JOIN situacao_fiscal s ON s.id = (SELECT MAX(id) FROM situacao_fiscal x WHERE x.empresa_id = e.id)
    WHERE e.escritorio_id = ? AND e.situacao = 'ATIVO' AND e.eh_escritorio = 0 ${filtro}
    ORDER BY CASE s.situacao WHEN 'PENDENCIAS' THEN 0 WHEN 'VERIFICAR' THEN 1 ELSE 2 END, cliente`).all(escritorioId, ...(empresas ?? [])) as any[])
    .map((l) => ({ ...l, tem_pdf: !!l.tem_pdf }));
}

export function detalheSituacao(escritorioId: number, id: number) {
  const s = db.prepare(`SELECT s.id, s.empresa_id, s.status, s.situacao, s.total_aberto, s.qtd_pendencias, s.erro, s.resumo_json, s.solicitada_em, s.concluida_em, (s.pdf IS NOT NULL) AS tem_pdf,
      COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, us.nome AS usuario
    FROM situacao_fiscal s JOIN empresas e ON e.id = s.empresa_id LEFT JOIN usuarios us ON us.id = s.usuario_id WHERE s.id = ? AND e.escritorio_id = ?`).get(id, escritorioId) as any;
  if (!s) throw new ErroNegocio('Consulta não encontrada.', 404);
  const historico = db.prepare(`SELECT id, status, situacao, total_aberto, qtd_pendencias, solicitada_em, concluida_em, (pdf IS NOT NULL) AS tem_pdf FROM situacao_fiscal WHERE empresa_id = ? ORDER BY id DESC LIMIT 20`).all(s.empresa_id);
  const { resumo_json, ...resto } = s;
  return { ...resto, tem_pdf: !!s.tem_pdf, resumo: resumo_json ? JSON.parse(resumo_json) : null, historico };
}

export function pdfSituacao(escritorioId: number, id: number) {
  const s = db.prepare('SELECT s.pdf, e.documento FROM situacao_fiscal s JOIN empresas e ON e.id = s.empresa_id WHERE s.id = ? AND e.escritorio_id = ?').get(id, escritorioId) as any;
  if (!s?.pdf) throw new ErroNegocio('Relatório não disponível.', 404);
  return { pdf: Buffer.from(s.pdf), nome: `situacao-fiscal-${s.documento}.pdf` };
}

export function resumoSituacoes(escritorioId: number, empresas: number[] | null = null) {
  const p = painelSituacao(escritorioId, empresas);
  return { comPendencias: p.filter((x) => x.situacao === 'PENDENCIAS').length, regulares: p.filter((x) => x.situacao === 'REGULAR').length,
    naoConsultados: p.filter((x) => !x.id).length, totalAberto: Math.round(p.reduce((t, x) => t + (x.situacao === 'PENDENCIAS' ? x.total_aberto ?? 0 : 0), 0) * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------
// Consulta automática (uma ou duas vezes por mês)
// ---------------------------------------------------------------------------------------------


const P_AGENDA = (e: number) => `sitfis_agenda:${e}`;
export const AgendaSitfis = z.object({
  ativo: z.boolean(),
  dias: z.array(z.number().int().min(1).max(28)).min(1, 'Escolha ao menos um dia').max(2, 'No máximo dois dias por mês'),
  emails: z.array(z.string().trim().email('E-mail inválido')).max(5),
});
interface AgendaSalva extends z.infer<typeof AgendaSitfis> { ultimaOcorrencia?: string | null; ultimaExecucao?: string | null; ultimoResultado?: string | null }

export function lerAgenda(escritorioId: number): AgendaSalva {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(P_AGENDA(escritorioId)) as any)?.valor;
  return v ? JSON.parse(v) : { ativo: false, dias: [1], emails: [] };
}
function gravarAgenda(escritorioId: number, a: AgendaSalva) {
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(P_AGENDA(escritorioId), JSON.stringify(a));
}
export function salvarAgenda(escritorioId: number, d: z.infer<typeof AgendaSitfis>) {
  const atual = lerAgenda(escritorioId);
  const dias = [...new Set(d.dias)].sort((a, b) => a - b);
  // ao ligar, não roda de imediato a ocorrência que já passou neste mês: começa na próxima
  const ultimaOcorrencia = d.ativo && !atual.ativo ? ocorrenciaDevida(dias, hojeBr()) : atual.ultimaOcorrencia ?? null;
  gravarAgenda(escritorioId, { ...atual, ...d, dias, ultimaOcorrencia });
}

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

/** Data da última ocorrência programada até hoje (AAAA-MM-DD): o maior dia já alcançado no mês, ou o último do mês anterior. */
export function ocorrenciaDevida(dias: number[], hoje: string): string {
  const [a, m, d] = hoje.split('-').map(Number);
  const ord = [...dias].sort((x, y) => x - y);
  const noMes = ord.filter((x) => x <= d).pop();
  if (noMes) return `${a}-${String(m).padStart(2, '0')}-${String(noMes).padStart(2, '0')}`;
  const [pa, pm] = m === 1 ? [a - 1, 12] : [a, m - 1];
  return `${pa}-${String(pm).padStart(2, '0')}-${String(ord[ord.length - 1]).padStart(2, '0')}`;
}

/** Próxima data programada depois de hoje. */
export function proximaOcorrencia(dias: number[], hoje: string): string {
  const [a, m, d] = hoje.split('-').map(Number);
  const ord = [...dias].sort((x, y) => x - y);
  const noMes = ord.find((x) => x > d);
  if (noMes) return `${a}-${String(m).padStart(2, '0')}-${String(noMes).padStart(2, '0')}`;
  const [pa, pm] = m === 12 ? [a + 1, 1] : [a, m + 1];
  return `${pa}-${String(pm).padStart(2, '0')}-${String(ord[0]).padStart(2, '0')}`;
}

export function statusAgenda(escritorioId: number) {
  const a = lerAgenda(escritorioId);
  const clientes = (db.prepare("SELECT COUNT(*) AS n FROM empresas WHERE escritorio_id = ? AND situacao = 'ATIVO' AND eh_escritorio = 0").get(escritorioId) as any).n as number;
  return { ...a, proxima: a.ativo ? proximaOcorrencia(a.dias, hojeBr()) : null, clientes, chamadasPorMes: clientes * 2 * a.dias.length };
}

const emExecucao = new Set<number>();

/** Monta o e-mail do resultado: pendências novas primeiro, depois as que continuam, e os erros. */
function linhasDoResumo(escritorioId: number, ids: number[]) {
  const novas: string[] = [], continuam: string[] = [], erros: string[] = [], aguardando: string[] = [];
  const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  for (const id of ids) {
    const [atual, anterior] = db.prepare('SELECT status, situacao, total_aberto, qtd_pendencias, erro FROM situacao_fiscal WHERE empresa_id = ? ORDER BY id DESC LIMIT 2').all(id) as any[];
    const nome = (db.prepare('SELECT COALESCE(nome_fantasia, razao_social) AS n FROM empresas WHERE id = ?').get(id) as any)?.n ?? String(id);
    if (!atual) continue;
    if (atual.status === 'ERRO') { erros.push(`• ${nome}: ${atual.erro}`); continue; }
    if (atual.status === 'SOLICITADA') { aguardando.push(`• ${nome}`); continue; }
    if (atual.situacao !== 'PENDENCIAS') continue;
    const linha = `• ${nome}: ${atual.qtd_pendencias} pendência(s)${atual.total_aberto ? `, ${brl(atual.total_aberto)}` : ''}`;
    const eraRegular = !anterior || anterior.situacao !== 'PENDENCIAS';
    const mudou = anterior?.situacao === 'PENDENCIAS' && Math.abs((anterior.total_aberto ?? 0) - (atual.total_aberto ?? 0)) > 0.009;
    (eraRegular ? novas : continuam).push(linha + (mudou ? ` (antes ${brl(anterior.total_aberto ?? 0)})` : ''));
  }
  return { novas, continuam, erros, aguardando };
}

/**
 * Chamada de tempos em tempos pelo servidor (com o programa aberto). No dia programado, ou na primeira abertura depois
 * dele, consulta todos os clientes ativos; relatórios que a Receita ainda não terminou são buscados nas rodadas seguintes.
 */
export async function sitfisAutomatico(agora = new Date(), opcoes: { transporte?: Transporte; esperar?: Espera } = {}) {
  const br = new Date(agora.getTime() - 3 * 3600e3);
  const hoje = br.toISOString().slice(0, 10);
  const feitos: { escritorio: number; consultados: number }[] = [];
  for (const { id } of db.prepare('SELECT id FROM escritorios').all() as { id: number }[]) {
    const a = lerAgenda(id);
    if (!a.ativo || emExecucao.has(id)) continue;
    if (!opcoes.transporte && lerConfig(id)?.ambiente !== 'PRODUCAO') continue;
    emExecucao.add(id);
    try {
      // relatórios pedidos que ainda estavam sendo gerados
      const pendentes = (db.prepare(`SELECT DISTINCT s.empresa_id FROM situacao_fiscal s JOIN empresas e ON e.id = s.empresa_id
        WHERE e.escritorio_id = ? AND s.status = 'SOLICITADA' AND s.id = (SELECT MAX(id) FROM situacao_fiscal x WHERE x.empresa_id = s.empresa_id)
          AND s.solicitada_em > datetime('now', '-12 hours') AND (s.liberar_em IS NULL OR s.liberar_em <= ?)`).all(id, agora.toISOString()) as { empresa_id: number }[]).map((x) => x.empresa_id);
      const devida = ocorrenciaDevida(a.dias, hoje);
      const vez = br.getUTCHours() >= 7 && (a.ultimaOcorrencia ?? '') < devida;
      if (!vez && !pendentes.length) continue;
      const usuario = (db.prepare("SELECT id FROM usuarios WHERE escritorio_id = ? AND tipo = 'adm' AND mestre = 0 ORDER BY id LIMIT 1").get(id) as any)?.id ?? null;
      if (vez) {
        // grava antes de começar: se o programa fechar no meio, a próxima abertura só busca os pendentes
        gravarAgenda(id, { ...a, ultimaOcorrencia: devida, ultimaExecucao: new Date().toISOString(), ultimoResultado: 'Em andamento…' });
        const ids = (db.prepare("SELECT id FROM empresas WHERE escritorio_id = ? AND situacao = 'ATIVO' AND eh_escritorio = 0 ORDER BY id").all(id) as { id: number }[]).map((x) => x.id);
        const r = await consultarVarios(id, usuario, ids, opcoes);
        const l = linhasDoResumo(id, ids);
        const resumo = `${r.prontos} relatório(s), ${r.comPendencias} com pendências (${l.novas.length} nova(s))${r.aguardando ? `, ${r.aguardando} aguardando a Receita` : ''}${r.erros ? `, ${r.erros} com erro` : ''}.`;
        let envio = '';
        if (a.emails.length) {
          const corpo = ['Olá!', '', `Resultado da consulta automática da situação fiscal (${hoje.split('-').reverse().join('/')}): ${resumo}`, '',
            ...(l.novas.length ? ['PENDÊNCIAS NOVAS', ...l.novas, ''] : []), ...(l.continuam.length ? ['CONTINUAM COM PENDÊNCIAS', ...l.continuam, ''] : []),
            ...(l.erros.length ? ['NÃO FOI POSSÍVEL CONSULTAR', ...l.erros, ''] : []), ...(l.aguardando.length ? ['AINDA EM GERAÇÃO NA RECEITA (o sistema busca sozinho)', ...l.aguardando, ''] : []),
            'Os detalhes e os PDFs estão em Escritório > Situação fiscal.', '', 'Kontor Gestão Contabilidade'];
          try { envio = (await enviarEmailSimples(id, a.emails, `Situação fiscal dos clientes — ${hoje.split('-').reverse().join('/')}`, corpo)) ? ' E-mail enviado.' : ' E-mail não enviado: configure o SMTP.'; }
          catch (e: any) { envio = ` Falha no e-mail: ${e?.message ?? e}`; }
        }
        gravarAgenda(id, { ...lerAgenda(id), ultimoResultado: resumo + envio });
        feitos.push({ escritorio: id, consultados: r.consultados });
      } else {
        await consultarVarios(id, usuario, pendentes, opcoes);
        feitos.push({ escritorio: id, consultados: pendentes.length });
      }
    } catch (e: any) {
      gravarAgenda(id, { ...lerAgenda(id), ultimoResultado: `Falha: ${e?.message ?? e}` });
    } finally { emExecucao.delete(id); }
  }
  return feitos;
}
