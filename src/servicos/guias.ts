import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { Integra, lerConfig, semProcuracao, textoMsgs, type Transporte } from './integra-contador.js';
import { siafiDoIbge } from './siafi.js';
import { lancarNoControle } from './controle-mensal.js';
import { lerGuia } from './fechamento.js';
import type { ItemPendencia } from './situacao-fiscal.js';

/**
 * Recálculo manual de guias em aberto pelo Integra Contador (uma guia por vez, um PDF por guia):
 * - DARF dos débitos da Receita (Sicalc: consolida multa e juros até a data de pagamento);
 * - DAS de cobrança do Simples Nacional (PGDAS-D: valor em cobrança, já com pagamentos parciais e parcelas);
 * - guia da DCTFWeb para as contribuições previdenciárias (a Receita não aceita DARF avulso para elas).
 * Cada guia é uma chamada cobrada pelo SERPRO; nada é gerado automaticamente.
 */

const DATA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const MES_ANO = z.string().trim().regex(/^\d{2}\/\d{4}$/, 'Informe o período como MM/AAAA');
export const PedidoGuia = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('DARF'),
    receita: z.string().trim().regex(/^\d{4}(-?\d{2})?$/, 'Código da receita: 4 dígitos, com a extensão (ex.: 1138-01)'),
    descricao: z.string().trim().max(120).nullish(),
    periodo: z.string().trim().min(4, 'Informe o período de apuração'),
    vencimento: DATA, valor: z.number().positive('Informe o valor do principal'),
    data: DATA, referencia: z.string().trim().max(30).nullish(),
  }),
  z.object({ tipo: z.literal('DAS'), periodo: MES_ANO, descricao: z.string().trim().max(120).nullish() }),
  z.object({ tipo: z.literal('DCTFWEB'), periodo: MES_ANO, data: DATA, descricao: z.string().trim().max(120).nullish() }),
]);
export type PedidoGuia = z.infer<typeof PedidoGuia>;

/** Contribuições previdenciárias declaradas na DCTFWeb (pagas só pela guia da própria DCTFWeb). */
const RECEITAS_DCTFWEB = new Set(['1082', '1099', '1138', '1141', '1162', '1170', '1176', '1181', '1191', '1196', '1200', '1213', '1218', '1221', '1225', '1646']);

/** Período do relatório → tipo e data do período no Sicalc. */
export function periodoSicalc(p: string): { tipoPA: string; dataPA: string } {
  const s = p.trim();
  if (/^\d{2}\/\d{4}$/.test(s)) return { tipoPA: 'ME', dataPA: s };
  if (/^\d{4}$/.test(s)) return { tipoPA: 'AN', dataPA: s };
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return { tipoPA: 'DI', dataPA: s };
  const tri = /^([1-4])\D*T\D*\/?(\d{4})$/i.exec(s.replace(/\s/g, ''));
  if (tri) return { tipoPA: 'TR', dataPA: `${tri[1]}/${tri[2]}` };
  throw new ErroNegocio(`Período "${p}" não reconhecido: use MM/AAAA (mensal), AAAA (anual) ou DD/MM/AAAA.`);
}

/** Qual guia recalcula um débito do relatório (sugestão: o usuário pode trocar antes de gerar). */
export function sugestaoGuia(i: ItemPendencia, secao = ''): Partial<PedidoGuia> | null {
  const mesAno = /\b(\d{2}\/\d{4})\b/.exec(i.periodo ?? i.texto ?? '')?.[1] ?? null;
  if (i.receita === 'SN' || /simples/i.test(secao) || /SIMPLES|\bDAS\b/i.test(i.descricao ?? '') || /^SIMPLES\s*NAC/i.test(i.texto ?? '')) return mesAno ? { tipo: 'DAS', periodo: mesAno, descricao: i.descricao ?? 'Simples Nacional' } : null;
  if (i.tipo !== 'DEBITO' || !i.receita) return null;
  const cod = i.receita.slice(0, 4);
  if ((RECEITAS_DCTFWEB.has(cod) || /^CP[\s-]/i.test(i.descricao ?? '')) && mesAno && !/MAED/i.test(i.descricao ?? '')) return { tipo: 'DCTFWEB', periodo: mesAno, descricao: i.descricao ?? null };
  return { tipo: 'DARF', receita: i.receita, descricao: i.descricao ?? null, periodo: i.periodo ?? '', vencimento: i.vencimento ?? undefined, valor: i.saldoDevedor ?? i.valorOriginal ?? undefined, referencia: i.notificacao ?? null };
}

/** Procura no retorno o PDF (base64) e os valores, qualquer que seja o nome do campo. */
function procurar(o: any, teste: (k: string, v: any) => boolean, prof = 0): any {
  if (!o || typeof o !== 'object' || prof > 6) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (teste(k, v)) return v;
    const r = procurar(v, teste, prof + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
const pdfDo = (d: any): string | null => (typeof d === 'string' && d.startsWith('JVBER') ? d : procurar(Array.isArray(d) ? { l: d } : d, (_k, v) => typeof v === 'string' && v.startsWith('JVBER')) ?? null);
const numero = (v: any) => (v == null || v === '' ? null : Number(String(v).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) || null);

export async function gerarGuia(escritorioId: number, usuarioId: number, empresaId: number, pedido: PedidoGuia, transporte?: Transporte) {
  if (!transporte && lerConfig(escritorioId)?.ambiente === 'DEMONSTRACAO') {
    throw new ErroNegocio('O Integra Contador está no ambiente de Demonstração, que não gera guias. Troque para Produção em Configurações > Integra Contador.');
  }
  const e = db.prepare('SELECT id, documento, uf, cod_municipio, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const i = Integra.para(escritorioId, transporte);
  const p = pedido;
  let r: Awaited<ReturnType<Integra['consultar']>>;
  let titulo: string;
  if (p.tipo === 'DARF') {
    const municipio = siafiDoIbge(e.cod_municipio);
    if (!municipio || !e.uf) throw new ErroNegocio('O cliente precisa do município (código IBGE) e da UF no cadastro da Carteira para o cálculo do DARF.');
    const [cod, ext = '01'] = p.receita.includes('-') ? p.receita.split('-') : [p.receita.slice(0, 4), p.receita.slice(4) || '01'];
    r = await i.consultar(e.documento, 'SICALC', 'CONSOLIDARGERARDARF51', {
      uf: String(e.uf).toUpperCase(), municipio, codigoReceita: cod, codigoReceitaExtensao: ext, ...periodoSicalc(p.periodo),
      vencimento: `${p.vencimento}T00:00:00`, valorImposto: p.valor.toFixed(2), dataConsolidacao: `${p.data}T00:00:00`,
      ...(p.referencia ? { numeroReferencia: p.referencia.replace(/\D/g, '') } : {}),
      observacao: 'Calculado pelo Kontor Gestão Contabilidade',
    }, 'Emitir');
    titulo = `DARF ${cod}-${ext} ${p.descricao ?? ''} — PA ${p.periodo}`.replace(/\s+/g, ' ').trim();
  } else if (p.tipo === 'DAS') {
    const [mm, aaaa] = p.periodo.split('/');
    r = await i.consultar(e.documento, 'PGDASD', 'GERARDASCOBRANCA17', { periodoApuracao: `${aaaa}${mm}` }, 'Emitir');
    titulo = `DAS Simples Nacional — PA ${p.periodo}`;
  } else {
    const [mm, aaaa] = p.periodo.split('/');
    r = await i.consultar(e.documento, 'DCTFWEB', 'GERARGUIA31', { categoria: 'GERAL_MENSAL', anoPA: aaaa, mesPA: mm, DataAcolhimentoProposta: Number(p.data.replace(/-/g, '')) }, 'Emitir');
    titulo = `Guia DCTFWeb — PA ${p.periodo}`;
  }
  const pdf = r.ok ? pdfDo(r.dados) : null;
  if (!pdf) {
    if (semProcuracao(r.mensagens)) throw new ErroNegocio('O cliente não deu procuração ao escritório no e-CAC para este serviço (Sicalc, Simples Nacional ou DCTFWeb).');
    throw new ErroNegocio(`A Receita não gerou a guia: ${textoMsgs(r.mensagens) || `HTTP ${r.http}`}`, 502);
  }
  const valor = numero(procurar(r.dados, (k, v) => /^(valorTotalConsolidado|valorTotal|valorTotalDas|totalConsolidado|valorDocumento)$/i.test(k) && v != null && typeof v !== 'object'));
  const validadeBruta = procurar(r.dados, (k, v) => /^(dataValidadeCalculo|dataLimiteAcolhimento|dataValidade|dataArrecadacao|dataPagamento)$/i.test(k) && v != null && typeof v !== 'object');
  const validade = validadeBruta ? (/^\d{8}$/.test(String(validadeBruta)) ? String(validadeBruta).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : String(validadeBruta).slice(0, 10)) : (p.tipo === 'DAS' ? null : p.data);
  let valorFinal = valor;
  if (p.tipo === 'DCTFWEB') {
    // o DARF da DCTFWeb emitido vai para o DARF Prev. da competência no Controle mensal
    if (valorFinal == null) valorFinal = (await lerGuia(Buffer.from(pdf, 'base64'))).valor;
    const [mm, aaaa] = p.periodo.split('/');
    lancarNoControle(empresaId, `${aaaa}-${mm}`, 'DP', 'darf_prev', valorFinal, usuarioId, true);
  }
  const res = db.prepare(`INSERT INTO guias_recalculadas (empresa_id, tipo, titulo, periodo, valor, validade, pdf, usuario_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(empresaId, p.tipo, titulo, p.periodo, valorFinal, validade, Buffer.from(pdf, 'base64'), usuarioId);
  return { id: Number(res.lastInsertRowid), titulo, valor: valorFinal, validade, nome: nomeArquivo(e.documento, p.tipo, p.periodo) };
}

const nomeArquivo = (doc: string, tipo: string, periodo: string) => `${tipo}-${doc}-${String(periodo).replace(/\D+/g, '-').replace(/^-|-$/g, '')}.pdf`;

export function listarGuias(escritorioId: number, empresaId: number) {
  return db.prepare(`SELECT g.id, g.tipo, g.titulo, g.periodo, g.valor, g.validade, g.criado_em, u.nome AS usuario FROM guias_recalculadas g JOIN empresas e ON e.id = g.empresa_id
    LEFT JOIN usuarios u ON u.id = g.usuario_id WHERE g.empresa_id = ? AND e.escritorio_id = ? ORDER BY g.id DESC LIMIT 50`).all(empresaId, escritorioId);
}

export function pdfGuia(escritorioId: number, id: number) {
  const g = db.prepare('SELECT g.pdf, g.tipo, g.periodo, e.documento FROM guias_recalculadas g JOIN empresas e ON e.id = g.empresa_id WHERE g.id = ? AND e.escritorio_id = ?').get(id, escritorioId) as any;
  if (!g) throw new ErroNegocio('Guia não encontrada.', 404);
  return { pdf: Buffer.from(g.pdf), nome: nomeArquivo(g.documento, g.tipo, g.periodo) };
}
