import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { Integra, semProcuracao, textoMsgs, type Transporte } from './integra-contador.js';

/**
 * Parcelamentos do Simples Nacional e do MEI (PARCSN, PARCSN-ESP, PERTSN, RELPSN, PARCMEI, PARCMEI-ESP, PERTMEI,
 * RELPMEI) e a caixa postal do e-CAC, pelo Integra Contador com a procuração do cliente ao escritório.
 * Cada chamada é cobrada pelo SERPRO; nada aqui roda sozinho.
 *
 * Caixa postal: só a LISTA de mensagens é consultada em lote. Abrir o conteúdo de uma mensagem (MSGDETALHAMENTO62)
 * pode registrar a leitura no e-CAC, e a leitura de uma intimação conta como ciência; por isso só acontece quando
 * alguém pede, mensagem a mensagem, depois de confirmar.
 */

export const SISTEMAS_PARC = [
  { id: 'PARCSN', nome: 'Parcelamento do Simples Nacional', n: 16, mei: false },
  { id: 'PARCSN-ESP', nome: 'Parcelamento especial do Simples Nacional', n: 17, mei: false },
  { id: 'PERTSN', nome: 'Pert-SN', n: 18, mei: false },
  { id: 'RELPSN', nome: 'Relp-SN', n: 19, mei: false },
  { id: 'PARCMEI', nome: 'Parcelamento do MEI', n: 20, mei: true },
  { id: 'PARCMEI-ESP', nome: 'Parcelamento especial do MEI', n: 21, mei: true },
  { id: 'PERTMEI', nome: 'Pert-MEI', n: 22, mei: true },
  { id: 'RELPMEI', nome: 'Relp-MEI', n: 23, mei: true },
] as const;

const ENCERRADO = /encerrad|conclu|rescindid|rescis|indeferid|cancelad|desist|liquidad|quitad|exclu/i;
const SEM_DADOS = /n[ãa]o (h[áa]|possui|existe|foram? encontrad|encontrad)|nenhum|inexist/i;
const mesAtual = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7).replace('-', '');
const dataReceita = (v: unknown) => { const s = String(v ?? ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || null; };
const r2 = (v: number) => Math.round(v * 100) / 100;

function cliente(escritorioId: number, empresaId: number) {
  const e = db.prepare('SELECT id, documento, regime, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  return e;
}
const lista = (d: any, chave: string): any[] => {
  if (!d || typeof d !== 'object') return [];
  if (Array.isArray(d[chave])) return d[chave];
  for (const v of Object.values(d)) { const r = lista(v, chave); if (r.length) return r; }
  return [];
};

// ---------------------------------------------------------------------------------------------
// Parcelamentos
// ---------------------------------------------------------------------------------------------

export async function consultarParcelamentos(escritorioId: number, usuarioId: number | null, empresaId: number, transporte?: Transporte) {
  const e = cliente(escritorioId, empresaId);
  if (e.regime !== 'SIMPLES' && e.regime !== 'MEI') throw new ErroNegocio('Os parcelamentos consultados aqui são os do Simples Nacional e do MEI: o cliente não está nesses regimes.');
  const i = Integra.para(escritorioId, transporte);
  const atual = mesAtual();
  const sistemas: any[] = [];
  for (const s of SISTEMAS_PARC.filter((x) => x.mei === (e.regime === 'MEI'))) {
    const r = await i.consultar(e.documento, s.id, `PEDIDOSPARC${s.n}3`, null);
    if (!r.ok) {
      const t = textoMsgs(r.mensagens);
      if (!semProcuracao(r.mensagens) && SEM_DADOS.test(t)) { sistemas.push({ sistema: s.id, nome: s.nome, pedidos: [], parcelas: [] }); continue; }
      sistemas.push({ sistema: s.id, nome: s.nome, pedidos: [], parcelas: [], erro: semProcuracao(r.mensagens) ? 'SEM_PROCURACAO' : t || `HTTP ${r.http}` });
      continue;
    }
    const pedidos = lista(r.dados, 'parcelamentos').map((p: any) => ({ numero: p.numero, dataDoPedido: dataReceita(p.dataDoPedido), situacao: String(p.situacao ?? ''), dataDaSituacao: dataReceita(p.dataDaSituacao), ativo: !ENCERRADO.test(String(p.situacao ?? '')) }));
    let parcelas: any[] = [];
    let erro: string | undefined;
    if (pedidos.some((p) => p.ativo)) {
      const rp = await i.consultar(e.documento, s.id, `PARCELASPARAGERAR${s.n}2`, null);
      if (rp.ok) parcelas = lista(rp.dados, 'listaParcelas').map((p: any) => ({ parcela: String(p.parcela ?? ''), valor: Number(p.valor ?? 0) || 0, atrasada: String(p.parcela ?? '') < atual }));
      else if (semProcuracao(rp.mensagens) || !SEM_DADOS.test(textoMsgs(rp.mensagens))) erro = textoMsgs(rp.mensagens) || `HTTP ${rp.http}`;
    }
    sistemas.push({ sistema: s.id, nome: s.nome, pedidos, parcelas, ...(erro ? { erro } : {}) });
  }
  const ativos = sistemas.reduce((a, s) => a + s.pedidos.filter((p: any) => p.ativo).length, 0);
  const atrasadas = sistemas.flatMap((s) => s.parcelas.filter((p: any) => p.atrasada));
  const erros = sistemas.filter((s) => s.erro);
  const situacao = erros.length === sistemas.length ? (erros.every((s) => s.erro === 'SEM_PROCURACAO') ? 'SEM_PROCURACAO' : 'ERRO')
    : atrasadas.length ? 'EM_ATRASO' : ativos ? 'EM_DIA' : 'SEM_PARCELAMENTO';
  const erro = erros.length ? erros.map((s) => `${s.nome}: ${s.erro === 'SEM_PROCURACAO' ? 'sem procuração' : s.erro}`).join(' · ') : null;
  db.prepare(`INSERT INTO parcelamentos_consultas (empresa_id, situacao, qtd_ativos, qtd_atrasadas, valor_atrasado, detalhe_json, erro, usuario_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(empresaId, situacao, ativos, atrasadas.length, r2(atrasadas.reduce((a, p) => a + p.valor, 0)), JSON.stringify(sistemas), erro, usuarioId);
  return { situacao, ativos, atrasadas: atrasadas.length, erro };
}

/** Gera o DAS de uma parcela (AAAAMM) e guarda com as guias do cliente. */
export async function emitirDasParcela(escritorioId: number, usuarioId: number, empresaId: number, sistema: string, parcela: string, transporte?: Transporte) {
  const e = cliente(escritorioId, empresaId);
  const s = SISTEMAS_PARC.find((x) => x.id === sistema);
  if (!s || !/^\d{6}$/.test(parcela)) throw new ErroNegocio('Parcela inválida.');
  const r = await Integra.para(escritorioId, transporte).consultar(e.documento, s.id, `GERARDAS${s.n}1`, { parcelaParaEmitir: Number(parcela) }, 'Emitir');
  const achar = (o: any, k: string): any => (o && typeof o === 'object' ? (k in o ? o[k] : Object.values(o).map((v) => achar(v, k)).find((v) => v != null)) : undefined);
  const pdf = r.ok ? achar(r.dados, 'docArrecadacaoPdfB64') : null;
  if (!pdf) {
    if (semProcuracao(r.mensagens)) throw new ErroNegocio('O cliente não deu procuração ao escritório no e-CAC para os parcelamentos do Simples Nacional.');
    throw new ErroNegocio(`A Receita não gerou o DAS da parcela: ${textoMsgs(r.mensagens) || `HTTP ${r.http}`}`, 502);
  }
  const periodo = `${parcela.slice(4)}/${parcela.slice(0, 4)}`;
  const valor = Number(achar(r.dados, 'valor') ?? achar(r.dados, 'valorTotal')) || null;
  const titulo = `DAS da parcela ${periodo} — ${s.nome}`;
  const res = db.prepare('INSERT INTO guias_recalculadas (empresa_id, tipo, titulo, periodo, valor, validade, pdf, usuario_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(empresaId, 'DAS', titulo, periodo, valor, dataReceita(achar(r.dados, 'dataVencimento')), Buffer.from(String(pdf), 'base64'), usuarioId);
  return { id: Number(res.lastInsertRowid), titulo, valor, nome: `DAS-parcela-${e.documento}-${parcela}.pdf` };
}

// ---------------------------------------------------------------------------------------------
// Caixa postal do e-CAC
// ---------------------------------------------------------------------------------------------

export async function consultarCaixaPostal(escritorioId: number, usuarioId: number | null, empresaId: number, transporte?: Transporte) {
  const e = cliente(escritorioId, empresaId);
  const r = await Integra.para(escritorioId, transporte).consultar(e.documento, 'CAIXAPOSTAL', 'MSGCONTRIBUINTE61', { statusLeitura: '0', indicadorPagina: '0', ponteiroPagina: '0'.repeat(24) });
  const grava = (situacao: string, msgs: any[], erro: string | null) => {
    const naoLidas = msgs.filter((m) => !m.lida);
    db.prepare('INSERT INTO caixa_postal_consultas (empresa_id, situacao, nao_lidas, relevantes, mensagens_json, erro, usuario_id) VALUES (?,?,?,?,?,?,?)')
      .run(empresaId, situacao, naoLidas.length, naoLidas.filter((m) => m.relevante).length, JSON.stringify(msgs), erro, usuarioId);
    return { situacao, nao_lidas: naoLidas.length, relevantes: naoLidas.filter((m) => m.relevante).length, erro };
  };
  if (!r.ok) {
    const t = textoMsgs(r.mensagens);
    if (!semProcuracao(r.mensagens) && SEM_DADOS.test(t)) return grava('OK', [], null);
    return grava(semProcuracao(r.mensagens) ? 'SEM_PROCURACAO' : 'ERRO', [], semProcuracao(r.mensagens) ? 'Sem procuração para a caixa postal.' : t || `HTTP ${r.http}`);
  }
  const msgs = lista(r.dados, 'listaMensagens').slice(0, 50).map((m: any) => ({
    isn: String(m.isn ?? ''),
    assunto: decodificarEntidades(String(m.assuntoModelo ?? '').replace(/\+\+VARIAVEL\+\+/g, String(m.valorParametroAssunto ?? ''))).trim(),
    enviada_em: dataReceita(m.dataEnvio),
    lida: String(m.indicadorLeitura ?? '') === '1',
    ciencia_em: dataReceita(m.dataCiencia) || null,
    relevante: String(m.relevancia ?? '') === '2',
    origem: String(m.descricaoOrigem ?? ''),
    controle: String(m.numeroControle ?? ''),
  }));
  return grava('OK', msgs, null);
}

/** Conteúdo de UMA mensagem. Pode registrar a leitura no e-CAC (e a ciência, se for intimação). */
// Texto da Receita vem em HTML, às vezes com as entidades escapadas duas vezes (&amp;aacute;).
const ENTIDADES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', deg: '°', sect: '§', middot: '·', bull: '•', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', euro: '€', copy: '©', reg: '®',
};
for (const [l, acentos] of Object.entries({ a: 'áàâãäå', e: 'éèêë', i: 'íìîï', o: 'óòôõö', u: 'úùûü' }))
  ['acute', 'grave', 'circ', 'tilde', 'uml', 'ring'].forEach((nome, k) => {
    const mapa: Record<string, number[]> = { a: [0, 1, 2, 3, 4, 5], e: [0, 1, 2, -1, 3, -1], i: [0, 1, 2, -1, 3, -1], o: [0, 1, 2, 3, 4, -1], u: [0, 1, 2, -1, 3, -1] };
    const pos = mapa[l][k]; if (pos < 0) return;
    ENTIDADES[l + nome] = acentos[pos]; ENTIDADES[l.toUpperCase() + nome] = acentos[pos].toUpperCase();
  });
Object.assign(ENTIDADES, { ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ' });
export function decodificarEntidades(s: string): string {
  for (let i = 0; i < 3 && /&(#\d+|#x[\da-f]+|[a-z]+\d*);/i.test(s); i++)
    s = s.replace(/&(#\d+|#x[\da-f]+|[a-z]+\d*);/gi, (x, n: string) => n[0] === '#' ? String.fromCodePoint(n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : Number(n.slice(1))) : ENTIDADES[n] ?? x);
  return s;
}
export function htmlParaTexto(html: string): string {
  if (!/<[a-z!/]/i.test(html) && /&(amp;)*lt;\s*\/?[a-z]/i.test(html)) html = decodificarEntidades(html); // HTML inteiro escapado
  const t = html.replace(/\r/g, '').replace(/\n/g, ' ')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ').replace(/<\/li>/gi, '')
    .replace(/<\/?(p|div|ul|ol|h[1-6]|table|tr|blockquote)[^>]*>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '');
  return decodificarEntidades(t).replace(/ /g, ' ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n(• )/g, '\n$1').replace(/\n{3,}/g, '\n\n').replace(/(\n• [^\n]*)\n\n(?=• )/g, '$1\n').trim();
}

export async function abrirMensagem(escritorioId: number, empresaId: number, isn: string, transporte?: Transporte) {
  const e = cliente(escritorioId, empresaId);
  if (!/^\d{1,12}$/.test(isn)) throw new ErroNegocio('Mensagem inválida.');
  const r = await Integra.para(escritorioId, transporte).consultar(e.documento, 'CAIXAPOSTAL', 'MSGDETALHAMENTO62', { isn });
  if (!r.ok) {
    if (semProcuracao(r.mensagens)) throw new ErroNegocio('O cliente não deu procuração ao escritório no e-CAC para a caixa postal.');
    throw new ErroNegocio(`A Receita não devolveu a mensagem: ${textoMsgs(r.mensagens) || `HTTP ${r.http}`}`, 502);
  }
  const m = lista(r.dados, 'conteudo')[0] ?? r.dados ?? {};
  const vars: string[] = Array.isArray(m.variaveis) ? m.variaveis.map(String) : [];
  const corpo = String(m.corpoModelo ?? '').replace(/\+\+(\d+)\+\+/g, (_x: string, n: string) => vars[Number(n) - 1] ?? '');
  // marca no histórico guardado que a mensagem foi aberta pelo Kontor
  const ult = db.prepare('SELECT id, mensagens_json FROM caixa_postal_consultas WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(empresaId) as any;
  if (ult?.mensagens_json) {
    const l = JSON.parse(ult.mensagens_json).map((x: any) => (x.isn === isn ? { ...x, lida: true, aberta_no_kontor: true } : x));
    const nl = l.filter((x: any) => !x.lida);
    db.prepare('UPDATE caixa_postal_consultas SET mensagens_json = ?, nao_lidas = ?, relevantes = ? WHERE id = ?').run(JSON.stringify(l), nl.length, nl.filter((x: any) => x.relevante).length, ult.id);
  }
  return {
    assunto: decodificarEntidades(String(m.assuntoModelo ?? '').replace(/\+\+VARIAVEL\+\+/g, String(m.valorParametroAssunto ?? ''))),
    enviada_em: dataReceita(m.dataEnvio), origem: String(m.descricaoOrigem ?? ''), controle: String(m.numeroControle ?? ''),
    ciencia_em: dataReceita(m.dataCiencia) || null,
    texto: htmlParaTexto(corpo),
  };
}

// ---------------------------------------------------------------------------------------------
// Último resultado de cada cliente (para o monitor e a tela do cliente)
// ---------------------------------------------------------------------------------------------

export function ultimosParcelamentos(ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  return new Map((db.prepare(`SELECT * FROM parcelamentos_consultas WHERE id IN (SELECT MAX(id) FROM parcelamentos_consultas WHERE empresa_id IN (${ids.join(',')}) GROUP BY empresa_id)`).all() as any[])
    .map((r) => [r.empresa_id, { ...r, detalhe: r.detalhe_json ? JSON.parse(r.detalhe_json) : [], detalhe_json: undefined }]));
}
export function ultimasCaixas(ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  return new Map((db.prepare(`SELECT * FROM caixa_postal_consultas WHERE id IN (SELECT MAX(id) FROM caixa_postal_consultas WHERE empresa_id IN (${ids.join(',')}) GROUP BY empresa_id)`).all() as any[])
    .map((r) => [r.empresa_id, { ...r, mensagens: r.mensagens_json ? JSON.parse(r.mensagens_json) : [], mensagens_json: undefined }]));
}

export function detalheCliente(escritorioId: number, empresaId: number) {
  const e = cliente(escritorioId, empresaId);
  return { empresa_id: e.id, cliente: e.cliente, documento: e.documento, regime: e.regime,
    parcelamentos: ultimosParcelamentos([e.id]).get(e.id) ?? null, caixa: ultimasCaixas([e.id]).get(e.id) ?? null };
}
