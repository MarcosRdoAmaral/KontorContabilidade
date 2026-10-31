import { diaUtil } from './diautil.js';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio, certificadoDaEmpresa } from './emissao.js';
import { Integra, lerConfig, semProcuracao, textoMsgs, type Transporte } from './integra-contador.js';
import { assinarDctfweb } from '../nfse/assinatura.js';
import { textoDoPdf } from './situacao-fiscal.js';
import { enviarComModelo } from './email.js';
import { camposCliente, camposMes, dataBr, moeda, renderizar, type Variaveis } from './modelos-email.js';
import { lancarNoControle } from './controle-mensal.js';

/**
 * Fechamento mensal pelo Integra Contador:
 * - DCTFWeb: busca a declaração "em andamento" (gerada pelo eSocial/EFD-Reinf), assina com o certificado do escritório,
 *   transmite, guarda o recibo e gera o DARF;
 * - PGDAS-D: calcula com as receitas por atividade (sem transmitir), transmite e gera o DAS;
 * - envio ao cliente: e-mail com as guias e o resumo (ou mensagem pronta para o WhatsApp).
 * Cada chamada ao Integra Contador é cobrada pelo SERPRO.
 */

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const partes = (mes: string) => { const [a, m] = mes.split('-'); return { anoPA: a, mesPA: m }; };
const MES = z.string().regex(/^\d{4}-\d{2}$/, 'Competência inválida');

function procurar(o: any, teste: (k: string, v: any) => boolean, prof = 0): any {
  if (!o || typeof o !== 'object' || prof > 6) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (teste(k, v)) return v;
    const r = procurar(v, teste, prof + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
const pdfB64 = (d: any, chave?: RegExp): string | null => {
  if (typeof d === 'string' && d.startsWith('JVBER')) return d;
  return procurar(Array.isArray(d) ? { l: d } : d, (k, v) => typeof v === 'string' && v.startsWith('JVBER') && (!chave || chave.test(k))) ?? null;
};

function empresaDoEscritorio(escritorioId: number, empresaId: number) {
  const e = db.prepare('SELECT * FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  return e;
}
function semDemonstracao(escritorioId: number, transporte?: Transporte) {
  if (!transporte && lerConfig(escritorioId)?.ambiente === 'DEMONSTRACAO') throw new ErroNegocio('O Integra Contador está no ambiente de Demonstração, que não transmite declarações. Troque para Produção em Configurações > Integra Contador.');
}
function erroIntegra(r: { mensagens: { codigo: string; texto: string }[]; http: number }, servico: string): never {
  if (semProcuracao(r.mensagens)) throw new ErroNegocio(`O cliente não deu procuração ao escritório no e-CAC para ${servico}.`);
  throw new ErroNegocio(`${servico}: ${textoMsgs(r.mensagens) || `HTTP ${r.http}`}`, 502);
}

function gravar(empresaId: number, mes: string, tipo: 'PGDASD' | 'DCTFWEB', usuarioId: number | null, c: Record<string, unknown>) {
  const cols = Object.keys(c);
  db.prepare(`INSERT INTO fechamentos (empresa_id, competencia, tipo, usuario_id, ${cols.join(', ')}) VALUES (?,?,?,?,${cols.map(() => '?').join(',')})
    ON CONFLICT(empresa_id, competencia, tipo) DO UPDATE SET usuario_id = excluded.usuario_id, atualizado_em = datetime('now'), ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}`)
    .run(empresaId, mes, tipo, usuarioId, ...cols.map((k) => c[k] as any));
}

function marcarTarefa(empresaId: number, mes: string, codigo: string, usuarioId: number, protocolo: string | null, obs: string) {
  db.prepare(`UPDATE tarefas SET status = 'ENTREGUE', entregue_em = ?, entregue_por = ?, protocolo = COALESCE(?, protocolo), observacao = TRIM(COALESCE(observacao || ' ', '') || ?), atualizada_em = datetime('now')
    WHERE empresa_id = ? AND competencia = ? AND status IN ('PENDENTE','ANDAMENTO') AND obrigacao_id IN (SELECT id FROM obrigacoes WHERE codigo = ?)`)
    .run(hojeBr(), usuarioId, protocolo, obs, empresaId, mes, codigo);
}

/**
 * Ao abrir o Controle mensal: grava o valor das guias emitidas no DARF Prev. (DP) e no imposto (Fiscal), substituindo
 * o que houver (a guia emitida manda; vale a mais recente entre o fechamento e a Situação fiscal). O envio ao cliente
 * não é marcado aqui: só quando o e-mail ou o WhatsApp sai.
 */
export async function sincronizarControle(escritorioId: number, mes: string) {
  const [aaaa, mm] = mes.split('-');
  // [empresa, área] -> guia mais recente
  const maisRecente = new Map<string, { empresa: number; area: 'DP' | 'FISCAL'; campo: string; quando: string; valor: () => Promise<number | null> }>();
  const candidata = (c: { empresa: number; area: 'DP' | 'FISCAL'; campo: string; quando: string; valor: () => Promise<number | null> }) => {
    const k = `${c.empresa}:${c.area}`; const atual = maisRecente.get(k);
    if (!atual || c.quando > atual.quando) maisRecente.set(k, c);
  };
  for (const f of db.prepare(`SELECT f.id, f.empresa_id, f.tipo, f.valor, f.atualizado_em FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id
      WHERE e.escritorio_id = ? AND f.competencia = ? AND f.situacao = 'TRANSMITIDA' AND f.guia_pdf IS NOT NULL`).all(escritorioId, mes) as any[]) {
    candidata({ empresa: f.empresa_id, area: f.tipo === 'DCTFWEB' ? 'DP' : 'FISCAL', campo: f.tipo === 'DCTFWEB' ? 'darf_prev' : 'imposto', quando: f.atualizado_em,
      valor: async () => {
        if (f.valor != null) return f.valor;
        const g = db.prepare('SELECT guia_pdf FROM fechamentos WHERE id = ?').get(f.id) as any;
        const lida = await lerGuia(Buffer.from(g.guia_pdf));
        if (lida.valor != null) db.prepare('UPDATE fechamentos SET valor = ?, vencimento = COALESCE(vencimento, ?) WHERE id = ?').run(lida.valor, lida.vencimento, f.id);
        return lida.valor;
      } });
  }
  // DARF da DCTFWeb emitido pela Situação fiscal (guias recalculadas)
  for (const g of db.prepare(`SELECT g.id, g.empresa_id, g.valor, g.criado_em FROM guias_recalculadas g JOIN empresas e ON e.id = g.empresa_id
      WHERE e.escritorio_id = ? AND g.tipo = 'DCTFWEB' AND g.periodo = ?`).all(escritorioId, `${mm}/${aaaa}`) as any[]) {
    candidata({ empresa: g.empresa_id, area: 'DP', campo: 'darf_prev', quando: g.criado_em,
      valor: async () => {
        if (g.valor != null) return g.valor;
        const r = db.prepare('SELECT pdf FROM guias_recalculadas WHERE id = ?').get(g.id) as any;
        const v = (await lerGuia(Buffer.from(r.pdf))).valor;
        if (v != null) db.prepare('UPDATE guias_recalculadas SET valor = ? WHERE id = ?').run(v, g.id);
        return v;
      } });
  }
  for (const c of maisRecente.values()) lancarNoControle(c.empresa, mes, c.area, c.campo, await c.valor(), null, true);
  // faturamento lido da declaração do PGDAS-D guardada (quando o controle ainda não tem)
  for (const f of db.prepare(`SELECT f.empresa_id, f.declaracao_pdf FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id
      WHERE e.escritorio_id = ? AND f.competencia = ? AND f.tipo = 'PGDASD' AND f.situacao = 'TRANSMITIDA' AND f.declaracao_pdf IS NOT NULL`).all(escritorioId, mes) as any[]) {
    if (dadosControle(f.empresa_id, mes, 'FISCAL').faturamento != null) continue;
    lancarNoControle(f.empresa_id, mes, 'FISCAL', 'faturamento', await faturamentoDaDeclaracao(Buffer.from(f.declaracao_pdf)), null);
  }
}

/** Valor e vencimento lidos do PDF da guia (DARF/DAS). */
export async function lerGuia(pdf: Buffer): Promise<{ valor: number | null; vencimento: string | null }> {
  let t = '';
  try { t = (await textoDoPdf(pdf)).replace(/\s+/g, ' '); } catch { return { valor: null, vencimento: null }; }
  const moeda = (s?: string) => (s ? Number(s.replace(/\./g, '').replace(',', '.')) : null);
  // "Valor Total do Documento"; se o texto do PDF vier fora de ordem, o total é o maior valor da guia (principal + multa + juros)
  const valores = [...t.matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{3})*,\d{2})(?![\d,])/g)].map((m) => moeda(m[1])!).filter((v) => v > 0);
  const valor = moeda(/valor\s+total(?:\s+do\s+documento)?\s*:?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/i.exec(t)?.[1]) ?? (valores.length ? Math.max(...valores) : null);
  const venc = /(?:pagar\s+(?:este\s+documento\s+)?at[ée]|data\s+de\s+vencimento|vencimento)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t)?.[1];
  return { valor, vencimento: venc ? venc.split('/').reverse().join('-') : null };
}

/** Codificação declarada no XML (a DCTFWeb costuma vir em UTF-8). */
const codificacao = (buf: Buffer): BufferEncoding => (/encoding=["']iso-8859-1["']/i.test(buf.subarray(0, 200).toString('latin1')) ? 'latin1' : 'utf8');

// ---------------------------------------------------------------------------------------------
// DCTFWeb
// ---------------------------------------------------------------------------------------------
const dadosControle = (empresaId: number, mes: string, area: 'FISCAL' | 'DP') => {
  const r = db.prepare('SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = ? AND area = ?').get(empresaId, mes, area) as any;
  return r ? JSON.parse(r.dados_json) : {};
};

/**
 * Receitas lidas do PDF da declaração do PGDAS-D: do mês (RPA), dos 12 meses anteriores (RBT12), acumulada no ano antes
 * do mês (RBA) e do ano anterior (RBAA). Cada linha traz mercado interno, externo e total; vale o total.
 */
export async function lerDeclaracaoPgdas(pdf: Buffer): Promise<{ rpa: number | null; rbt12: number | null; rba: number | null; rbaa: number | null }> {
  let t = '';
  try { t = (await textoDoPdf(pdf)).replace(/\s+/g, ' '); } catch { return { rpa: null, rbt12: null, rba: null, rbaa: null }; }
  const moeda = (x: string) => Number(x.replace(/\./g, '').replace(',', '.'));
  const valor = (rotulo: RegExp) => {
    const m = new RegExp(rotulo.source + '[^\\d]{0,40}?((?:\\d{1,3}(?:\\.\\d{3})*,\\d{2}\\s*){1,3})', 'i').exec(t);
    if (!m) return null;
    const v = m[1].trim().split(/\s+/).map(moeda);
    return v.length >= 3 ? v[2] : v[0];
  };
  return {
    rpa: valor(/Receita\s+Bruta\s+do\s+PA\s*\(RPA\)\s*-?\s*Compet[êe]ncia/),
    rbt12: valor(/\(RBT12\)/),
    rba: valor(/\(RBA\)/),
    rbaa: valor(/\(RBAA\)/),
  };
}
/** Faturamento (receita bruta do PA) lido do PDF da declaração do PGDAS-D. */
export async function faturamentoDaDeclaracao(pdf: Buffer): Promise<number | null> { return (await lerDeclaracaoPgdas(pdf)).rpa; }

/** Guarda as receitas da declaração (para o faturamento acumulado e o sublimite) e devolve o faturamento do mês. */
export async function registrarReceitas(empresaId: number, mes: string, pdf: Buffer | null) {
  if (!pdf) return null;
  const r = await lerDeclaracaoPgdas(pdf);
  db.prepare(`INSERT INTO pgdas_receitas (empresa_id, competencia, rpa, rbt12, rba, rbaa) VALUES (?,?,?,?,?,?)
    ON CONFLICT(empresa_id, competencia) DO UPDATE SET rpa = excluded.rpa, rbt12 = excluded.rbt12, rba = excluded.rba, rbaa = excluded.rbaa, lido_em = datetime('now')`)
    .run(empresaId, mes, r.rpa, r.rbt12, r.rba, r.rbaa);
  return r.rpa;
}

/** Lê as declarações guardadas que ainda não foram lidas (antes de mostrar o Monitor). */
export async function atualizarReceitas(escritorioId: number) {
  const l = db.prepare(`SELECT f.empresa_id, f.competencia, f.declaracao_pdf FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id
    WHERE e.escritorio_id = ? AND f.tipo = 'PGDASD' AND f.declaracao_pdf IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pgdas_receitas r WHERE r.empresa_id = f.empresa_id AND r.competencia = f.competencia)`).all(escritorioId) as any[];
  for (const f of l) await registrarReceitas(f.empresa_id, f.competencia, Buffer.from(f.declaracao_pdf));
}

/**
 * Só a declaração do PGDAS-D (sem gerar DAS): uma chamada. Guarda declaração e recibo, as receitas e o faturamento
 * do mês no controle. Para o faturamento acumulado do Monitor.
 */
export async function consultarDeclaracaoPgdas(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, transporte?: Transporte) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const r = await Integra.para(escritorioId, transporte).consultar(e.documento, 'PGDASD', 'CONSULTIMADECREC14', { periodoApuracao: mes.replace('-', '') }, 'Consultar');
  if (!r.ok) erroIntegra(r, 'PGDAS-D (consulta da declaração)');
  const d = Array.isArray(r.dados) ? r.dados[0] : r.dados;
  if (!d?.numeroDeclaracao) throw new ErroNegocio('Não há PGDAS-D transmitido para este período.');
  const pdfDe = (o: any) => (typeof o?.pdf === 'string' && o.pdf ? Buffer.from(o.pdf, 'base64') : null);
  const decl = pdfDe(d.declaracao);
  gravar(empresaId, mes, 'PGDASD', usuarioId, { situacao: 'TRANSMITIDA', recibo: String(d.numeroDeclaracao), declaracao_pdf: decl, recibo_pdf: pdfDe(d.recibo) });
  const faturamento = await registrarReceitas(empresaId, mes, decl);
  lancarNoControle(empresaId, mes, 'FISCAL', 'faturamento', faturamento, usuarioId, true);
  const rec = db.prepare('SELECT rbt12, rba FROM pgdas_receitas WHERE empresa_id = ? AND competencia = ?').get(empresaId, mes) as any;
  return { recibo: String(d.numeroDeclaracao), faturamento, rbt12: rec?.rbt12 ?? null, rba: rec?.rba ?? null };
}

const JA_TRANSMITIDA = /Ja_Transmitida|j[áa] (foi )?transmitida|j[áa] existe declara/i;

/**
 * Transmite a DCTFWeb em andamento e gera o DARF. Com soBuscar = true não transmite nada: só busca o recibo e
 * gera o DARF da declaração já transmitida por outro sistema (SCI, Domínio, e-CAC...).
 */
export async function transmitirDctfweb(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, transporte?: Transporte, soBuscar = false, dataPagamento?: string | null) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const i = Integra.para(escritorioId, transporte);
  const dados = { categoria: 'GERAL_MENSAL', ...partes(mes) };
  if (!soBuscar && !dadosControle(empresaId, mes, 'DP').sem_folha)
    throw new ErroNegocio('O Kontor só transmite a DCTFWeb sem movimento. Marque "Sem folha" no Controle mensal (aba Departamento pessoal) ou, se a declaração já foi transmitida, use "Buscar recibo e DARF já transmitidos".');
  try {
    let jaTransmitida = soBuscar;
    let recibo: string | null = null;
    if (!soBuscar) {
    const r1 = await i.consultar(e.documento, 'DCTFWEB', 'CONSXMLDECLARACAO38', dados, 'Consultar');
    const b64 = r1.ok ? procurar(r1.dados, (k, v) => /xml/i.test(k) && typeof v === 'string' && v.length > 20) : null;
    if (!b64) erroIntegra(r1, 'DCTFWeb (XML da declaração)');
    const bruto = Buffer.from(b64, 'base64');
    const enc = codificacao(bruto);
    const xml = bruto.toString(enc);
    jaTransmitida = /<(?:[\w-]+:)?Signature[\s>]/.test(xml);
    if (!jaTransmitida) {
      const esc = db.prepare('SELECT * FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
      if (!esc?.cert_pfx_enc) throw new ErroNegocio('Envie o certificado A1 do escritório em Cadastros > Empresas: a DCTFWeb é assinada com ele.');
      const assinado = assinarDctfweb(xml, certificadoDaEmpresa(esc));
      const r2 = await i.consultar(e.documento, 'DCTFWEB', 'TRANSDECLARACAO310', { ...dados, xmlAssinadoBase64: Buffer.from(assinado, enc).toString('base64') }, 'Declarar');
      if (!r2.ok && JA_TRANSMITIDA.test(textoMsgs(r2.mensagens))) jaTransmitida = true; // transmitida por outro sistema: só busca recibo e DARF
      else {
        if (!r2.ok) erroIntegra(r2, 'DCTFWeb (transmissão)');
        recibo = procurar(r2.dados, (k, v) => /recibo/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 6) ?? null;
      }
    }
    }
    // recibo e DARF: falhas aqui não desfazem a transmissão
    let reciboPdf: string | null = null, guia: string | null = null, avisoGuia: string | null = null;
    try {
      const r3 = await i.consultar(e.documento, 'DCTFWEB', 'CONSRECIBO32', dados, 'Consultar');
      reciboPdf = r3.ok ? pdfB64(r3.dados) : null;
      if (soBuscar && !reciboPdf) erroIntegra(r3.ok ? { ...r3, mensagens: [{ codigo: '', texto: 'Não há DCTFWeb transmitida para este período.' }] } : r3, 'DCTFWeb (recibo)');
    } catch (err) { if (soBuscar) throw err; /* segue */ }
    // DARF: com a data de pagamento escolhida; sem ela, a Receita usa hoje. Se o cálculo de juros e multa falhar
    // (acontece em fim de semana/feriado ou instabilidade da Receita), tenta de novo com o próximo dia útil.
    const gerar = (data?: string | null) => i.consultar(e.documento, 'DCTFWEB', 'GERARGUIA31', { ...dados, ...(data ? { DataAcolhimentoProposta: Number(data.replace(/-/g, '')) } : {}) }, 'Emitir');
    try {
      let r4 = await gerar(dataPagamento);
      guia = r4.ok ? pdfB64(r4.dados) : null;
      if (!guia && !dataPagamento && /juros|multa|inesperad/i.test(textoMsgs(r4.mensagens))) {
        r4 = await gerar(diaUtil(hojeBr(), 1));
        guia = r4.ok ? pdfB64(r4.dados) : null;
      }
      if (!guia) {
        const t = textoMsgs(r4.mensagens);
        avisoGuia = /juros|multa|inesperad/i.test(t)
          ? 'A Receita não conseguiu calcular juros e multa do DARF (erro no sistema da própria Receita). A declaração está transmitida: gere o DARF de novo mais tarde ou escolha outra data de pagamento.'
          : t || 'A DCTFWeb não gerou DARF (sem valor a pagar ou já pago).';
      }
    } catch (err: any) { avisoGuia = err?.message ?? String(err); }
    const lida = guia ? await lerGuia(Buffer.from(guia, 'base64')) : { valor: null, vencimento: null };
    // sem DARF novo, mantém o que já estava guardado
    gravar(empresaId, mes, 'DCTFWEB', usuarioId, {
      situacao: 'TRANSMITIDA', ...(recibo ? { recibo: String(recibo) } : {}), ...(jaTransmitida ? {} : { transmitida_em: new Date().toISOString() }),
      ...(reciboPdf ? { recibo_pdf: Buffer.from(reciboPdf, 'base64') } : {}),
      ...(guia ? { guia_pdf: Buffer.from(guia, 'base64'), valor: lida.valor, vencimento: lida.vencimento } : {}), erro: avisoGuia,
    });
    marcarTarefa(empresaId, mes, 'DCTFWEB', usuarioId, recibo ? String(recibo) : null, jaTransmitida ? 'DCTFWeb transmitida por outro sistema; recibo e DARF buscados pelo Kontor.' : 'DCTFWeb transmitida pelo Kontor (Integra Contador).');
    lancarNoControle(empresaId, mes, 'DP', 'darf_prev', lida.valor, usuarioId, true);
    return { jaTransmitida, recibo, valor: lida.valor, vencimento: lida.vencimento, temGuia: !!guia, aviso: avisoGuia };
  } catch (err: any) {
    // uma busca que não achou nada não estraga um fechamento já guardado
    const atual = db.prepare("SELECT situacao FROM fechamentos WHERE empresa_id = ? AND competencia = ? AND tipo = 'DCTFWEB'").get(empresaId, mes) as any;
    if (!(soBuscar && atual?.situacao === 'TRANSMITIDA')) gravar(empresaId, mes, 'DCTFWEB', usuarioId, { situacao: 'ERRO', erro: String(err?.message ?? err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// PGDAS-D
// ---------------------------------------------------------------------------------------------
/** Atividades do PGDAS-D (as mais usadas; a lista completa tem 43). */
export const ATIVIDADES_PGDAS: Record<number, string> = {
  1: 'Revenda de mercadorias — sem ST', 2: 'Revenda de mercadorias — com ST/monofásica', 3: 'Revenda de mercadorias para o exterior',
  4: 'Venda de industrializados — sem ST', 5: 'Venda de industrializados — com ST/monofásica', 6: 'Venda de industrializados para o exterior',
  7: 'Locação de bens móveis', 9: 'Serviços contábeis com ISS fixo',
  10: 'Serviços Fator R — ISS para outro município', 11: 'Serviços Fator R — ISS no próprio município', 12: 'Serviços Fator R — com retenção de ISS',
  13: 'Serviços Anexo III — ISS para outro município', 14: 'Serviços Anexo III — ISS no próprio município', 15: 'Serviços Anexo III — com retenção de ISS',
  16: 'Serviços Anexo IV — ISS para outro município', 17: 'Serviços Anexo IV — ISS no próprio município', 18: 'Serviços Anexo IV — com retenção de ISS',
  19: 'Construção civil Anexo III — ISS para outro município', 20: 'Construção civil Anexo III — ISS no próprio município', 21: 'Construção civil Anexo III — com retenção de ISS',
  22: 'Construção civil Anexo IV — ISS para outro município', 23: 'Construção civil Anexo IV — ISS no próprio município', 24: 'Construção civil Anexo IV — com retenção de ISS',
  29: 'Serviços para o exterior — Fator R', 30: 'Serviços para o exterior — Anexo III', 31: 'Serviços para o exterior — Anexo IV',
  34: 'Transporte intermunicipal/interestadual — sem ST de ICMS', 35: 'Transporte intermunicipal/interestadual — com ST de ICMS', 38: 'Transporte para o exterior',
  41: 'Atividade com IPI e ISS — ISS no próprio município', 42: 'Atividade com IPI e ISS — com retenção de ISS',
};
export const TRIBUTOS_SN: Record<number, string> = { 1001: 'IRPJ', 1002: 'CSLL', 1004: 'COFINS', 1005: 'PIS', 1006: 'CPP', 1007: 'ICMS', 1008: 'IPI', 1010: 'ISS' };

export const AtividadesCliente = z.array(z.number().int().refine((n) => n >= 1 && n <= 43, 'Atividade inválida')).max(10);
export function salvarAtividades(escritorioId: number, empresaId: number, ids: number[]) {
  empresaDoEscritorio(escritorioId, empresaId);
  db.prepare('UPDATE empresas SET pgdas_atividades = ? WHERE id = ?').run(ids.length ? JSON.stringify([...new Set(ids)]) : null, empresaId);
  return { ok: true };
}

export const EntradaPgdas = z.object({
  receitas: z.array(z.object({ idAtividade: z.number().int().min(1).max(43), valor: z.number().min(0).max(1e10) })).max(10),
  folha: z.number().min(0).max(1e10).nullish(),
  retificadora: z.boolean().default(false),
});
type EntradaPgdas = z.infer<typeof EntradaPgdas>;

function declaracaoPgdas(e: any, mes: string, d: EntradaPgdas) {
  const pa = Number(mes.replace('-', ''));
  const ativ = d.receitas.filter((r) => r.valor > 0);
  const total = Math.round(ativ.reduce((t, r) => t + r.valor, 0) * 100) / 100;
  return {
    cnpjCompleto: e.documento, pa,
    declaracao: {
      tipoDeclaracao: d.retificadora ? 2 : 1,
      receitaPaCompetenciaInterno: total, receitaPaCompetenciaExterno: 0,
      ...(d.folha != null ? { folhasSalario: [{ pa, valor: d.folha }] } : {}),
      estabelecimentos: [{ cnpjCompleto: e.documento, ...(ativ.length ? { atividades: ativ.map((r) => ({ idAtividade: r.idAtividade, valorAtividade: r.valor, receitasAtividade: [{ valor: r.valor }] })) } : {}) }],
    },
  };
}

const valoresDevidos = (dados: any): { codigoTributo: number; valor: number }[] => {
  const l = procurar(Array.isArray(dados) ? { l: dados } : dados, (k, v) => k === 'valoresDevidos' && Array.isArray(v));
  return (l ?? []).map((x: any) => ({ codigoTributo: Number(x.codigoTributo), valor: Number(x.valor) }));
};

/** Calcula o PGDAS-D sem transmitir (indicadorTransmissao = false). */
export async function calcularPgdas(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, entrada: EntradaPgdas, transporte?: Transporte) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const i = Integra.para(escritorioId, transporte);
  const r = await i.consultar(e.documento, 'PGDASD', 'TRANSDECLARACAO11', { ...declaracaoPgdas(e, mes, entrada), indicadorTransmissao: false, indicadorComparacao: false }, 'Declarar');
  if (!r.ok) erroIntegra(r, 'PGDAS-D (cálculo)');
  const valores = valoresDevidos(r.dados);
  const total = Math.round(valores.reduce((t, v) => t + v.valor, 0) * 100) / 100;
  gravar(empresaId, mes, 'PGDASD', usuarioId, { situacao: 'CALCULADO', entrada_json: JSON.stringify(entrada), valores_json: JSON.stringify(valores), valor: total, erro: null });
  return { valores, total };
}

/**
 * PGDAS-D transmitido por outro sistema (SCI, portal do Simples...): busca a última declaração do período com o
 * recibo (CONSULTIMADECREC14) e gera o DAS (GERARDAS12). Não transmite nada.
 */
export async function buscarPgdas(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, transporte?: Transporte) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const i = Integra.para(escritorioId, transporte);
  const pa = mes.replace('-', '');
  const r = await i.consultar(e.documento, 'PGDASD', 'CONSULTIMADECREC14', { periodoApuracao: pa }, 'Consultar');
  if (!r.ok) erroIntegra(r, 'PGDAS-D (consulta da declaração)');
  const d = Array.isArray(r.dados) ? r.dados[0] : r.dados;
  const numero = d?.numeroDeclaracao ? String(d.numeroDeclaracao) : null;
  if (!numero) throw new ErroNegocio('Não há PGDAS-D transmitido para este período.');
  const pdfDe = (o: any) => (typeof o?.pdf === 'string' && o.pdf ? Buffer.from(o.pdf, 'base64') : null);
  let das: string | null = null, aviso: string | null = null;
  try {
    const g = await i.consultar(e.documento, 'PGDASD', 'GERARDAS12', { periodoApuracao: pa }, 'Emitir');
    das = g.ok ? pdfB64(g.dados) : null;
    if (!das) aviso = textoMsgs(g.mensagens) || 'O DAS não foi gerado (sem valor a pagar ou já pago).';
  } catch (err: any) { aviso = err?.message ?? String(err); }
  const lida = das ? await lerGuia(Buffer.from(das, 'base64')) : { valor: null, vencimento: null };
  gravar(empresaId, mes, 'PGDASD', usuarioId, {
    situacao: 'TRANSMITIDA', recibo: numero, transmitida_em: null, valor: lida.valor, vencimento: lida.vencimento,
    declaracao_pdf: pdfDe(d?.declaracao), recibo_pdf: pdfDe(d?.recibo), guia_pdf: das ? Buffer.from(das, 'base64') : null, erro: aviso,
  });
  marcarTarefa(empresaId, mes, 'DAS', usuarioId, numero, 'PGDAS-D transmitido por outro sistema; declaração e DAS buscados pelo Kontor.');
  const faturamento = await registrarReceitas(empresaId, mes, pdfDe(d?.declaracao));
  lancarNoControle(empresaId, mes, 'FISCAL', 'faturamento', faturamento, usuarioId, true);
  lancarNoControle(empresaId, mes, 'FISCAL', 'imposto', lida.valor ?? (faturamento === 0 ? 0 : null), usuarioId, true);
  return { recibo: numero, faturamento, valor: lida.valor, vencimento: lida.vencimento, temGuia: !!das, aviso, maed: !!d?.maed };
}

/**
 * PGDAS-D sem faturamento no mês (receita zero): o único que o Kontor transmite. Não há DAS. Marca a obrigação como
 * entregue e o mês como sem movimento no Controle mensal.
 */
export async function transmitirPgdasZerado(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, retificadora = false, transporte?: Transporte) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  if (e.regime !== 'SIMPLES') throw new ErroNegocio('O PGDAS-D é só para clientes do Simples Nacional.');
  const entrada: EntradaPgdas = { receitas: [], folha: null, retificadora };
  const i = Integra.para(escritorioId, transporte);
  try {
    const r = await i.consultar(e.documento, 'PGDASD', 'TRANSDECLARACAO11', { ...declaracaoPgdas(e, mes, entrada), indicadorTransmissao: true, indicadorComparacao: false }, 'Declarar');
    if (!r.ok) {
      if (/j[áa] (existe|foi transmitid|h[áa] declara)|retifica/i.test(textoMsgs(r.mensagens)) && !retificadora)
        throw new ErroNegocio('Já existe declaração do PGDAS-D neste mês. Para trocar por uma zerada, marque "Retificadora"; se ela já está certa, use "Buscar declaração e DAS já transmitidos".');
      erroIntegra(r, 'PGDAS-D (transmissão sem faturamento)');
    }
    const t = Array.isArray(r.dados) ? r.dados[0] : r.dados;
    const recibo = t?.idDeclaracao ? String(t.idDeclaracao) : null;
    gravar(empresaId, mes, 'PGDASD', usuarioId, {
      situacao: 'TRANSMITIDA', recibo, transmitida_em: new Date().toISOString(), valor: 0, vencimento: null, entrada_json: JSON.stringify(entrada), valores_json: '[]',
      declaracao_pdf: t?.declaracao ? Buffer.from(t.declaracao, 'base64') : null, recibo_pdf: t?.recibo ? Buffer.from(t.recibo, 'base64') : null, guia_pdf: null, erro: null,
    });
    marcarTarefa(empresaId, mes, 'DAS', usuarioId, recibo, 'PGDAS-D sem faturamento transmitido pelo Kontor (Integra Contador).');
    await registrarReceitas(empresaId, mes, t?.declaracao ? Buffer.from(t.declaracao, 'base64') : null);
    lancarNoControle(empresaId, mes, 'FISCAL', 'faturamento', 0, usuarioId, true);
    lancarNoControle(empresaId, mes, 'FISCAL', 'imposto', 0, usuarioId, true);
    lancarNoControle(empresaId, mes, 'FISCAL', 'sem_movimento', true, usuarioId, true);
    return { recibo };
  } catch (err: any) {
    const atual = db.prepare("SELECT situacao FROM fechamentos WHERE empresa_id = ? AND competencia = ? AND tipo = 'PGDASD'").get(empresaId, mes) as any;
    if (atual?.situacao !== 'TRANSMITIDA') gravar(empresaId, mes, 'PGDASD', usuarioId, { situacao: 'ERRO', erro: String(err?.message ?? err) });
    throw err;
  }
}

/** Transmite o PGDAS-D (comparando com o cálculo já conferido) e gera o DAS. */
export async function transmitirPgdas(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, entrada: EntradaPgdas, transporte?: Transporte) {
  const mes = MES.parse(mesBr);
  semDemonstracao(escritorioId, transporte);
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const calc = db.prepare("SELECT entrada_json, valores_json FROM fechamentos WHERE empresa_id = ? AND competencia = ? AND tipo = 'PGDASD'").get(empresaId, mes) as any;
  if (!calc?.valores_json || calc.entrada_json !== JSON.stringify(entrada)) throw new ErroNegocio('Calcule de novo antes de transmitir: as receitas mudaram desde o último cálculo.');
  const valores = JSON.parse(calc.valores_json) as { codigoTributo: number; valor: number }[];
  const i = Integra.para(escritorioId, transporte);
  try {
    const r = await i.consultar(e.documento, 'PGDASD', 'TRANSDECLARACAO11', {
      ...declaracaoPgdas(e, mes, entrada), indicadorTransmissao: true, indicadorComparacao: valores.length > 0, ...(valores.length ? { valoresParaComparacao: valores } : {}),
    }, 'Declarar');
    if (!r.ok) erroIntegra(r, 'PGDAS-D (transmissão)');
    const t = Array.isArray(r.dados) ? r.dados[0] : r.dados;
    const recibo = t?.idDeclaracao ? String(t.idDeclaracao) : null;
    let das: string | null = null, aviso: string | null = null;
    const total = Math.round(valores.reduce((s, v) => s + v.valor, 0) * 100) / 100;
    if (total > 0) {
      try {
        const g = await i.consultar(e.documento, 'PGDASD', 'GERARDAS12', { periodoApuracao: mes.replace('-', '') }, 'Emitir');
        das = g.ok ? pdfB64(g.dados) : null;
        if (!das) aviso = textoMsgs(g.mensagens) || 'O DAS não foi gerado.';
      } catch (err: any) { aviso = err?.message ?? String(err); }
    }
    const lida = das ? await lerGuia(Buffer.from(das, 'base64')) : { valor: null, vencimento: null };
    gravar(empresaId, mes, 'PGDASD', usuarioId, {
      situacao: 'TRANSMITIDA', recibo, transmitida_em: new Date().toISOString(), valor: lida.valor ?? total, vencimento: lida.vencimento,
      declaracao_pdf: t?.declaracao ? Buffer.from(t.declaracao, 'base64') : null, recibo_pdf: t?.recibo ? Buffer.from(t.recibo, 'base64') : null,
      guia_pdf: das ? Buffer.from(das, 'base64') : null, erro: aviso,
    });
    marcarTarefa(empresaId, mes, 'DAS', usuarioId, recibo, 'PGDAS-D transmitido pelo Kontor (Integra Contador).');
    const fat = Math.round(entrada.receitas.reduce((s, x) => s + x.valor, 0) * 100) / 100;
    lancarNoControle(empresaId, mes, 'FISCAL', 'faturamento', fat, usuarioId);
    lancarNoControle(empresaId, mes, 'FISCAL', 'imposto', lida.valor ?? total, usuarioId);
    return { recibo, total, valor: lida.valor ?? total, vencimento: lida.vencimento, temGuia: !!das, aviso, maed: !!t?.notificacaoMaed };
  } catch (err: any) {
    gravar(empresaId, mes, 'PGDASD', usuarioId, { situacao: 'ERRO', erro: String(err?.message ?? err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Consulta, arquivos e envio ao cliente
// ---------------------------------------------------------------------------------------------
export function fechamentoDoCliente(escritorioId: number, empresaId: number, mes: string) {
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const l = db.prepare(`SELECT f.tipo, f.situacao, f.entrada_json, f.valores_json, f.valor, f.vencimento, f.recibo, f.transmitida_em, f.erro, f.atualizado_em, u.nome AS usuario,
      f.declaracao_pdf IS NOT NULL AS tem_declaracao, f.recibo_pdf IS NOT NULL AS tem_recibo, f.guia_pdf IS NOT NULL AS tem_guia
    FROM fechamentos f LEFT JOIN usuarios u ON u.id = f.usuario_id WHERE f.empresa_id = ? AND f.competencia = ?`).all(empresaId, mes) as any[];
  const por = Object.fromEntries(l.map(({ entrada_json, valores_json, ...x }) => [x.tipo, { ...x, tem_declaracao: !!x.tem_declaracao, tem_recibo: !!x.tem_recibo, tem_guia: !!x.tem_guia,
    entrada: entrada_json ? JSON.parse(entrada_json) : null, valores: valores_json ? JSON.parse(valores_json) : null }]));
  const envios = db.prepare('SELECT canal, destino, itens, enviado_em FROM envios_fechamento WHERE empresa_id = ? AND competencia = ? ORDER BY id DESC').all(empresaId, mes);
  return { empresa_id: e.id, cliente: e.nome_fantasia || e.razao_social, documento: e.documento, email: e.email, fone: e.contato_fone, canal_envio: e.canal_envio, regime: e.regime,
    tem_funcionarios: !!e.tem_funcionarios, atividades: e.pgdas_atividades ? JSON.parse(e.pgdas_atividades) : [], PGDASD: por.PGDASD ?? null, DCTFWEB: por.DCTFWEB ?? null, envios,
    sem_movimento: !!dadosControle(empresaId, mes, 'FISCAL').sem_movimento, sem_folha: !!dadosControle(empresaId, mes, 'DP').sem_folha };
}

/** Situação do fechamento de todos os clientes no mês (para a tela). */
export function resumoFechamentos(escritorioId: number, mes: string) {
  const l = db.prepare(`SELECT f.empresa_id, f.tipo, f.situacao, f.valor, f.vencimento, f.guia_pdf IS NOT NULL AS tem_guia, f.erro FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id
    WHERE e.escritorio_id = ? AND f.competencia = ?`).all(escritorioId, mes) as any[];
  const env = db.prepare(`SELECT v.empresa_id, v.itens, v.enviado_em FROM envios_fechamento v JOIN empresas e ON e.id = v.empresa_id WHERE e.escritorio_id = ? AND v.competencia = ? ORDER BY v.enviado_em`).all(escritorioId, mes) as any[];
  const r: Record<number, any> = {};
  for (const x of l) (r[x.empresa_id] ??= {})[x.tipo] = { situacao: x.situacao, valor: x.valor, vencimento: x.vencimento, tem_guia: !!x.tem_guia, erro: x.erro };
  for (const x of env) {
    const o = (r[x.empresa_id] ??= {});
    o.enviado_em = x.enviado_em;
    for (const t of String(x.itens ?? '').split(',').filter(Boolean)) o[`enviado_${t}`] = x.enviado_em; // enviado_PGDASD, enviado_DCTFWEB
  }
  return r;
}

export function arquivoFechamento(escritorioId: number, empresaId: number, mes: string, tipo: 'PGDASD' | 'DCTFWEB', qual: 'guia' | 'recibo' | 'declaracao') {
  const e = empresaDoEscritorio(escritorioId, empresaId);
  const f = db.prepare(`SELECT ${qual}_pdf AS pdf FROM fechamentos WHERE empresa_id = ? AND competencia = ? AND tipo = ?`).get(empresaId, mes, tipo) as any;
  if (!f?.pdf) throw new ErroNegocio('Arquivo não disponível.', 404);
  const nome = `${tipo === 'PGDASD' ? (qual === 'guia' ? 'DAS' : `PGDAS-D-${qual}`) : qual === 'guia' ? 'DARF-DCTFWeb' : `DCTFWeb-${qual}`}-${e.documento}-${mes}.pdf`;
  return { pdf: Buffer.from(f.pdf), nome };
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const rotuloMes = (mes: string) => `${mes.slice(5)}/${mes.slice(0, 4)}`;

/** Texto do fechamento para o cliente (e-mail ou WhatsApp). */
export type TipoGuia = 'PGDASD' | 'DCTFWEB';

/** Mensagem ao cliente. Com `tipo`, só aquela guia (o DAS vai separado do DARF); sem ele, as duas (como antes). */
export function mensagemFechamento(escritorioId: number, empresaId: number, mes: string, tipo?: TipoGuia | null) {
  const f = fechamentoDoCliente(escritorioId, empresaId, mes);
  const guias = [
    f.PGDASD?.tem_guia ? { tipo: 'PGDASD', nome: 'DAS — Simples Nacional', valor: f.PGDASD.valor, venc: f.PGDASD.vencimento } : null,
    f.DCTFWEB?.tem_guia ? { tipo: 'DCTFWEB', nome: 'DARF — DCTFWeb (INSS)', valor: f.DCTFWEB.valor, venc: f.DCTFWEB.vencimento } : null,
  ].filter((g) => g && (!tipo || g.tipo === tipo)) as { tipo: TipoGuia; nome: string; valor: number | null; venc: string | null }[];
  // Sem tipo (envio antigo, das duas guias juntas) usa o modelo do DAS com as duas guias no quadro.
  const chave = (tipo === 'DCTFWEB' ? 'darf' : 'das') + (guias.length ? '' : '_zero');
  const vars: Variaveis = {
    ...camposCliente(empresaId), ...camposMes(mes),
    guias: guias.map((g) => ({ rotulo: g.nome, valor: moeda(g.valor), detalhe: g.venc ? `Vencimento ${dataBr(g.venc)}` : null })),
    valor: guias.length === 1 ? moeda(guias[0].valor) : '', vencimento: guias.length === 1 ? dataBr(guias[0].venc) : '',
  };
  const r = renderizar(escritorioId, chave, vars);
  return { linhas: r.linhas, html: r.html, guias, assunto: r.assunto, chave, vars, cliente: f.cliente, email: f.email, fone: f.fone, canal: f.canal_envio };
}

/** Envia por e-mail o fechamento ao cliente (com as guias anexas) e registra o envio no Controle mensal. */
export async function enviarFechamento(escritorioId: number, usuarioId: number, empresaId: number, mesBr: string, canal: 'EMAIL' | 'WHATSAPP', tipo?: TipoGuia | null) {
  const mes = MES.parse(mesBr);
  const m = mensagemFechamento(escritorioId, empresaId, mes, tipo);
  let destino: string | null = null;
  if (canal === 'EMAIL') {
    if (!m.email) throw new ErroNegocio('O cliente não tem e-mail no cadastro da Carteira.');
    const anexos = m.guias.map((g) => { const a = arquivoFechamento(escritorioId, empresaId, mes, g.tipo, 'guia'); return { filename: a.nome, content: a.pdf, contentType: 'application/pdf' }; });
    const ok = await enviarComModelo(escritorioId, m.chave, m.vars, m.email.split(/[,;\s]+/).filter(Boolean), { anexos });
    if (!ok) throw new ErroNegocio('Configure o envio de e-mail (SMTP) em Configurações > E-mail.');
    destino = m.email;
  } else destino = m.fone ?? null; // o WhatsApp é aberto na tela com a mensagem; aqui só fica o registro
  const itens = tipo ? [tipo] : m.guias.map((g) => g.tipo);
  db.prepare('INSERT INTO envios_fechamento (empresa_id, competencia, canal, destino, itens, usuario_id) VALUES (?,?,?,?,?,?)').run(empresaId, mes, canal, destino, itens.join(','), usuarioId);
  // marca "enviado" na área do Controle mensal da guia enviada (Fiscal = DAS, DP = DARF)
  for (const area of [itens.includes('PGDASD') ? 'FISCAL' : null, itens.includes('DCTFWEB') ? 'DP' : null].filter(Boolean) as ('FISCAL' | 'DP')[]) {
    const atual = db.prepare('SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = ? AND area = ?').get(empresaId, mes, area) as any;
    const d = atual ? JSON.parse(atual.dados_json) : {};
    d.enviado ??= hojeBr();
    db.prepare(`INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json, usuario_id) VALUES (?,?,?,?,?)
      ON CONFLICT(empresa_id, competencia, area) DO UPDATE SET dados_json = excluded.dados_json, usuario_id = excluded.usuario_id, atualizado_em = datetime('now')`).run(empresaId, mes, area, JSON.stringify(d), usuarioId);
  }
  if (canal === 'EMAIL' || canal === 'WHATSAPP') db.prepare('UPDATE empresas SET canal_envio = COALESCE(canal_envio, ?) WHERE id = ?').run(canal, empresaId);
  return { enviadoPara: destino, guias: m.guias.length };
}
