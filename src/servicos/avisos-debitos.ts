import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { enviarEmailSimples } from './email.js';
import type { RelatorioLido } from './situacao-fiscal.js';

/**
 * Aviso ao cliente dos débitos em aberto na situação fiscal (sem guias: o cliente procura o escritório quando quiser
 * pagar e as guias são recalculadas na hora). Só vai para os clientes marcados "avisar débitos em aberto".
 */

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');
const fmtDoc = (d: string) => (d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'));

export function marcarAviso(escritorioId: number, empresaIds: number[], avisar: boolean) {
  const up = db.prepare('UPDATE empresas SET avisar_debitos = ? WHERE id = ? AND escritorio_id = ?');
  db.transaction(() => { for (const id of empresaIds) up.run(avisar ? 1 : 0, id, escritorioId); })();
}

/** Última consulta pronta do cliente. */
function ultimaConsulta(empresaId: number) {
  return db.prepare("SELECT id, situacao, resumo_json, concluida_em, solicitada_em FROM situacao_fiscal WHERE empresa_id = ? AND status = 'PRONTA' ORDER BY id DESC LIMIT 1").get(empresaId) as any;
}

/** Texto do e-mail ao cliente (linhas). */
export function textoDoAviso(escritorioId: number, empresaId: number) {
  const e = db.prepare('SELECT id, documento, razao_social, nome_fantasia, email, contato_nome FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const s = ultimaConsulta(empresaId);
  if (!s || s.situacao !== 'PENDENCIAS' || !s.resumo_json) throw new ErroNegocio('A última consulta deste cliente não tem débitos em aberto para avisar.');
  const r = JSON.parse(s.resumo_json) as RelatorioLido;
  const esc = db.prepare('SELECT razao_social, nome_fantasia, email FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  const escNome = esc?.nome_fantasia || esc?.razao_social || 'Escritório de contabilidade';
  const debitos = r.secoes.filter((x) => x.tipo === 'PENDENCIA' && x.orgao === 'RFB').flatMap((x) => x.itens).filter((i) => i.tipo === 'DEBITO');
  const inscricoes = r.secoes.filter((x) => x.tipo === 'PENDENCIA' && x.orgao === 'PGFN').flatMap((x) => x.itens).filter((i) => i.tipo === 'INSCRICAO');
  const porTributo = new Map<string, { nome: string; periodos: string[]; total: number }>();
  for (const i of debitos) {
    const k = `${i.receita ?? ''} ${i.descricao ?? ''}`.trim();
    const g = porTributo.get(k) ?? { nome: i.descricao || i.receita || 'Débito', periodos: [], total: 0 };
    if (i.periodo) g.periodos.push(i.periodo); g.total += i.saldo ?? 0; porTributo.set(k, g);
  }
  const linhas = [`Olá${e.contato_nome ? `, ${e.contato_nome}` : ''}!`, '',
    `Na consulta à situação fiscal de ${e.nome_fantasia || e.razao_social} (${fmtDoc(e.documento)}) feita em ${dataBr(s.concluida_em ?? s.solicitada_em)}, constam os seguintes débitos em aberto:`, ''];
  if (porTributo.size) {
    linhas.push('NA RECEITA FEDERAL');
    for (const g of [...porTributo.values()].sort((a, b) => b.total - a.total)) {
      linhas.push(`• ${g.nome}${g.periodos.length ? ` — período(s) ${g.periodos.slice(0, 6).join(', ')}${g.periodos.length > 6 ? ` e mais ${g.periodos.length - 6}` : ''}` : ''}: ${brl(g.total)}`);
    }
    linhas.push(`Total aproximado, com multa e juros até a data da consulta: ${brl(r.totalAberto)}`, '');
  }
  if (inscricoes.length) {
    linhas.push('EM DÍVIDA ATIVA (PROCURADORIA-GERAL DA FAZENDA NACIONAL)');
    // agrupadas por tributo: a lista inteira (às vezes dezenas de inscrições) fica no relatório
    const grupos = new Map<string, { n: number; ajuizadas: number }>();
    for (const i of inscricoes) { const k = i.descricao || i.receita || 'Outras'; const g = grupos.get(k) ?? { n: 0, ajuizadas: 0 }; g.n++; if (/ajuizad/i.test(i.situacao ?? '')) g.ajuizadas++; grupos.set(k, g); }
    for (const [k, g] of [...grupos].sort((a, b) => b[1].n - a[1].n)) linhas.push(`• ${k}: ${g.n} inscrição(ões)${g.ajuizadas ? `, ${g.ajuizadas} ajuizada(s)` : ''}`);
    linhas.push('');
  }
  linhas.push('Enquanto houver débitos em aberto, a certidão negativa de débitos fica impedida e os valores continuam corrigindo com multa e juros.',
    'Quando quiser regularizar, fale com a gente: emitimos as guias atualizadas para a data em que você for pagar, ou vemos um parcelamento.', '', escNome);
  return { para: e.email as string | null, assunto: `Débitos em aberto — ${e.nome_fantasia || e.razao_social}`, linhas, situacaoId: s.id as number };
}

export async function avisarCliente(escritorioId: number, empresaId: number, usuarioId: number | null, automatico = false) {
  const t = textoDoAviso(escritorioId, empresaId);
  if (!t.para) throw new ErroNegocio('O cliente não tem e-mail no cadastro da Carteira.');
  const emails = t.para.split(/[,;\s]+/).filter(Boolean);
  const ok = await enviarEmailSimples(escritorioId, emails, t.assunto, t.linhas);
  if (!ok) throw new ErroNegocio('Configure o envio de e-mail (SMTP) em Configurações > E-mail.');
  db.prepare('INSERT INTO avisos_debitos (empresa_id, situacao_fiscal_id, emails, usuario_id, automatico) VALUES (?,?,?,?,?)').run(empresaId, t.situacaoId, emails.join(', '), usuarioId, automatico ? 1 : 0);
  return { enviadoPara: emails };
}

/**
 * Depois da consulta automática: avisa os clientes marcados cuja consulta desta rodada (iniciada a partir de `desde`)
 * terminou com pendências e ainda não foi avisada.
 */
export async function avisarMarcadosAutomaticamente(escritorioId: number, desde: string) {
  const alvos = db.prepare(`SELECT e.id FROM empresas e JOIN situacao_fiscal s ON s.id = (SELECT MAX(x.id) FROM situacao_fiscal x WHERE x.empresa_id = e.id AND x.status = 'PRONTA')
    WHERE e.escritorio_id = ? AND e.avisar_debitos = 1 AND e.na_carteira = 1 AND e.situacao = 'ATIVO' AND s.situacao = 'PENDENCIAS' AND s.solicitada_em >= ?
      AND NOT EXISTS (SELECT 1 FROM avisos_debitos a WHERE a.situacao_fiscal_id = s.id)`).all(escritorioId, desde) as { id: number }[];
  const r = { enviados: 0, falhas: [] as string[] };
  for (const { id } of alvos) {
    try { await avisarCliente(escritorioId, id, null, true); r.enviados++; }
    catch (e: any) { r.falhas.push(`${(db.prepare('SELECT COALESCE(nome_fantasia, razao_social) AS n FROM empresas WHERE id = ?').get(id) as any)?.n}: ${e?.message ?? e}`); }
  }
  return r;
}

export function ultimosAvisos(empresaId: number) {
  return db.prepare(`SELECT a.id, a.emails, a.enviado_em, a.automatico, u.nome AS usuario FROM avisos_debitos a LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.empresa_id = ? ORDER BY a.id DESC LIMIT 10`).all(empresaId);
}
