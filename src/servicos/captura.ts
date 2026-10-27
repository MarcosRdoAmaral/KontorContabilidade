import { strToU8 } from 'fflate';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { buscarNaSefaz, configurarBusca } from './nfe-recebidas.js';
import { pacoteContabilidade } from './contabilidade.js';
import { buscarNoAdn, configurarAdn, listarNfseCapturadas } from './nfse-capturadas.js';
import { listarSaidas, saidasForaDaCarteira } from './nfe-saidas.js';

/**
 * Captura de documentos da carteira, numa tela para todos os clientes:
 *  - NF-e de compra: Distribuição DF-e da SEFAZ com o certificado A1 do cliente;
 *  - NF-e de venda: a mesma distribuição, mas com o certificado do escritório (o cliente informa o CNPJ do escritório no autXML);
 *  - NFS-e prestadas e tomadas: Ambiente de Dados Nacional (ADN) com o certificado do cliente;
 *  - NFS-e emitidas pelo próprio sistema.
 */

const fimDoMes = (mes: string) => `${mes}-${String(new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5), 0)).getUTCDate()).padStart(2, '0')}`;
const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const brNum = (v: number | null | undefined) => (v == null ? '' : v.toFixed(2).replace('.', ','));
const dataBr = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');

export function statusCaptura(escritorioId: number, mes: string, empresas: number[] | null = null) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  const de = `${mes}-01`, ate = fimDoMes(mes);
  const linhas = db.prepare(`SELECT e.id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.uf, e.cert_validade, e.eh_escritorio,
      (e.cert_pfx_enc IS NOT NULL) AS tem_certificado, d.ultima_consulta, d.proxima_consulta, d.ultimo_resultado, d.ultimo_erro, d.automatica,
      (d.empresa_id IS NOT NULL) AS iniciada,
      a.ultima_consulta AS adn_ultima, a.proxima_consulta AS adn_proxima, a.ultimo_resultado AS adn_resultado, a.ultimo_erro AS adn_erro, a.automatica AS adn_automatica,
      (a.empresa_id IS NOT NULL) AS adn_iniciada,
      (SELECT COUNT(*) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ?) AS nfe_mes,
      (SELECT COUNT(*) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ? AND r.xml IS NULL AND r.situacao = 'AUTORIZADA') AS nfe_sem_xml,
      (SELECT COALESCE(SUM(r.valor),0) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ? AND r.situacao = 'AUTORIZADA') AS nfe_valor,
      (SELECT COUNT(*) FROM nfe_saidas s WHERE s.escritorio_id = e.escritorio_id AND s.emitente_documento = e.documento AND s.xml IS NOT NULL AND s.emissao BETWEEN ? AND ?) AS vendas_mes,
      (SELECT COALESCE(SUM(s.valor),0) FROM nfe_saidas s WHERE s.escritorio_id = e.escritorio_id AND s.emitente_documento = e.documento AND s.xml IS NOT NULL AND s.situacao = 'AUTORIZADA' AND s.emissao BETWEEN ? AND ?) AS vendas_valor,
      (SELECT COUNT(*) FROM nfse_capturadas c WHERE c.empresa_id = e.id AND c.papel = 'PRESTADOR' AND c.xml IS NOT NULL AND c.competencia BETWEEN ? AND ?) AS nfse_prestadas,
      (SELECT COUNT(*) FROM notas n WHERE n.empresa_id = e.id AND n.ambiente = e.ambiente AND n.status IN ('AUTORIZADA','CANCELADA') AND n.competencia BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM nfse_capturadas c WHERE c.empresa_id = e.id AND c.chave = n.chave_acesso)) AS nfse_sistema,
      (SELECT COUNT(*) FROM nfse_capturadas c WHERE c.empresa_id = e.id AND c.papel = 'TOMADOR' AND c.xml IS NOT NULL AND c.competencia BETWEEN ? AND ?) AS nfse_tomadas
    FROM empresas e LEFT JOIN nfe_distribuicao d ON d.empresa_id = e.id LEFT JOIN adn_distribuicao a ON a.empresa_id = e.id
    WHERE e.escritorio_id = ? AND e.situacao != 'ENCERRADO' ${filtro} ORDER BY e.eh_escritorio DESC, cliente`).all(de, ate, de, ate, de, ate, de, ate, de, ate, de, ate, de, ate, de, ate, escritorioId, ...(empresas ?? [])) as any[];
  const agora = new Date().toISOString();
  return linhas.map((l) => {
    const certOk = !!l.tem_certificado && !(l.cert_validade && l.cert_validade < agora);
    return {
      ...l, tem_certificado: !!l.tem_certificado, eh_escritorio: !!l.eh_escritorio, iniciada: !!l.iniciada, automatica: l.iniciada ? !!l.automatica : false,
      adn_iniciada: !!l.adn_iniciada, adn_automatica: l.adn_iniciada ? !!l.adn_automatica : false,
      cert_vencido: l.cert_validade ? l.cert_validade < agora : false,
      nfse_prestadas: l.nfse_prestadas + l.nfse_sistema,
      pode_consultar: certOk && (!l.proxima_consulta || l.proxima_consulta <= agora),
      pode_adn: certOk && !l.eh_escritorio && (!l.adn_proxima || l.adn_proxima <= agora),
    };
  });
}

/** Situação da captura das notas de venda pelo certificado do escritório. */
export function statusAutXml(escritorioId: number, mes: string) {
  const esc = db.prepare(`SELECT e.id, e.documento, COALESCE(e.nome_fantasia, e.razao_social) AS nome, (e.cert_pfx_enc IS NOT NULL) AS tem_certificado, e.cert_validade,
      d.ultima_consulta, d.ultimo_resultado, d.ultimo_erro FROM empresas e LEFT JOIN nfe_distribuicao d ON d.empresa_id = e.id
    WHERE e.escritorio_id = ? AND e.eh_escritorio = 1`).get(escritorioId) as any;
  const de = `${mes}-01`, ate = fimDoMes(mes);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM nfe_saidas WHERE escritorio_id = ? AND xml IS NOT NULL AND emissao BETWEEN ? AND ?').get(escritorioId, de, ate) as any).n as number;
  return {
    escritorio: esc ? { ...esc, tem_certificado: !!esc.tem_certificado, cert_vencido: esc.cert_validade ? esc.cert_validade < new Date().toISOString() : false } : null,
    notasNoMes: total,
    foraDaCarteira: saidasForaDaCarteira(escritorioId, de, ate),
  };
}

let capturaEmAndamento = false;
type BuscaSefaz = (id: number) => Promise<{ novas?: number; saidas?: number; resumo?: string; aviso?: string | null }>;
type BuscaAdn = (id: number) => Promise<{ prestadas: number; tomadas: number; resumo: string }>;

/**
 * Consulta, para cada cliente que já pode, a SEFAZ (compras; no escritório, também as vendas dos clientes)
 * e o Ambiente Nacional da NFS-e. Respeita o intervalo de 1 hora de cada serviço quando não há documentos novos.
 */
export async function capturarTodos(escritorioId: number, empresas: number[] | null = null, buscar: BuscaSefaz = buscarNaSefaz, buscarAdn: BuscaAdn = buscarNoAdn) {
  if (capturaEmAndamento) throw new ErroNegocio('Já há uma captura em andamento. Aguarde terminar.', 409);
  capturaEmAndamento = true;
  try {
    const alvo = statusCaptura(escritorioId, new Date().toISOString().slice(0, 7), empresas).filter((l) => l.pode_consultar || l.pode_adn);
    const resultados: { empresa_id: number; cliente: string; ok: boolean; novas: number; mensagem: string }[] = [];
    for (const l of alvo) {
      const msgs: string[] = [];
      let ok = true, novas = 0;
      if (l.pode_consultar) {
        try {
          const r = await buscar(l.id);
          novas += (r.novas ?? 0) + (r.saidas ?? 0);
          msgs.push(`NF-e: ${r.resumo ?? (r.aviso || 'consulta feita')}`);
        } catch (e: any) { ok = false; msgs.push(`NF-e: ${String(e?.message ?? e)}`); }
      }
      if (l.pode_adn) {
        try {
          const r = await buscarAdn(l.id);
          novas += r.prestadas + r.tomadas;
          msgs.push(r.resumo);
        } catch (e: any) { ok = false; msgs.push(`NFS-e: ${String(e?.message ?? e)}`); }
      }
      resultados.push({ empresa_id: l.id, cliente: l.cliente, ok, novas, mensagem: msgs.join(' · ') });
    }
    return { consultados: resultados.length, novas: resultados.reduce((s, r) => s + r.novas, 0), erros: resultados.filter((r) => !r.ok).length, resultados };
  } finally { capturaEmAndamento = false; }
}

/** Liga (ou desliga) a busca automática de NF-e e de NFS-e para todos os clientes com certificado. */
export function automaticaParaTodos(escritorioId: number, ligar: boolean, empresas: number[] | null = null) {
  const alvo = statusCaptura(escritorioId, new Date().toISOString().slice(0, 7), empresas).filter((l) => l.tem_certificado);
  for (const l of alvo) {
    configurarBusca(l.id, ligar);
    if (!l.eh_escritorio) configurarAdn(l.id, ligar);
  }
  return { alterados: alvo.length };
}

/** Notas do mês do cliente: vendas (autXML) e NFS-e capturadas. */
export function notasDoMes(escritorioId: number, empresaId: number, mes: string) {
  const e = db.prepare('SELECT documento FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const de = `${mes}-01`, ate = fimDoMes(mes);
  return { vendas: listarSaidas(escritorioId, e.documento, de, ate), nfse: listarNfseCapturadas(empresaId, de, ate) };
}

/**
 * Pacote do mês do cliente: NFS-e emitidas pelo sistema, NF-e de compra (lançadas e baixadas da SEFAZ),
 * NF-e de venda (autXML) e NFS-e prestadas/tomadas do Ambiente Nacional, com planilhas de conferência.
 */
export function pacoteDoMes(empresaId: number, mes: string) {
  const e = db.prepare('SELECT escritorio_id, documento FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const de = `${mes}-01`, ate = fimDoMes(mes);
  const extras: Record<string, Uint8Array> = {};
  const vendas = db.prepare('SELECT chave, numero, serie, modelo, emissao, destinatario_documento, destinatario_nome, valor, situacao, xml FROM nfe_saidas WHERE escritorio_id = ? AND emitente_documento = ? AND xml IS NOT NULL AND emissao BETWEEN ? AND ? ORDER BY emissao')
    .all(e.escritorio_id, e.documento, de, ate) as any[];
  for (const v of vendas) extras[`vendas/nfe/NFe_${v.chave}.xml`] = strToU8(v.xml);
  if (vendas.length) {
    const cab = ['Emissão', 'Número', 'Série', 'Modelo', 'Destinatário', 'CPF/CNPJ', 'Valor', 'Situação', 'Chave'];
    extras['vendas/relatorio-vendas.csv'] = strToU8('﻿' + [cab.map(csv).join(';'), ...vendas.map((v) => [dataBr(v.emissao), v.numero, v.serie, v.modelo, v.destinatario_nome, v.destinatario_documento, brNum(v.valor), v.situacao, v.chave].map(csv).join(';'))].join('\r\n'));
  }
  const nfse = db.prepare(`SELECT c.*, EXISTS (SELECT 1 FROM notas n WHERE n.empresa_id = c.empresa_id AND n.chave_acesso = c.chave) AS do_sistema FROM nfse_capturadas c
    WHERE c.empresa_id = ? AND c.xml IS NOT NULL AND c.competencia BETWEEN ? AND ? ORDER BY c.competencia`).all(empresaId, de, ate) as any[];
  for (const n of nfse) {
    const pasta = n.papel === 'PRESTADOR' ? 'prestadas' : n.papel === 'TOMADOR' ? 'tomadas' : 'outras';
    if (n.papel === 'PRESTADOR' && n.do_sistema) continue; // já vai em notas/xml, pelo pacote das notas emitidas aqui
    extras[`servicos/${pasta}/NFSe_${n.numero ?? n.chave}_${n.chave.slice(-8)}.xml`] = strToU8(n.xml);
  }
  if (nfse.length) {
    const cab = ['Papel', 'Competência', 'Número', 'Prestador', 'CNPJ/CPF prestador', 'Tomador', 'CNPJ/CPF tomador', 'Município', 'Valor do serviço', 'ISS', 'ISS retido', 'Valor líquido', 'Situação', 'Chave'];
    extras['servicos/relatorio-nfse.csv'] = strToU8('﻿' + [cab.map(csv).join(';'), ...nfse.map((n) => [{ PRESTADOR: 'Prestada', TOMADOR: 'Tomada', OUTRO: 'Outra' }[n.papel as string], dataBr(n.competencia), n.numero, n.prestador_nome, n.prestador_documento, n.tomador_nome, n.tomador_documento,
      n.municipio, brNum(n.valor), brNum(n.iss), n.iss_retido ? 'Sim' : 'Não', brNum(n.valor_liquido), n.situacao, n.chave].map(csv).join(';'))].join('\r\n'));
  }
  return pacoteContabilidade(empresaId, { de, ate, xml: true, pdf: false, ofx: false, entradas: true, sefaz: true, extras });
}
