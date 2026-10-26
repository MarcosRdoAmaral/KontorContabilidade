import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { buscarNaSefaz, configurarBusca } from './nfe-recebidas.js';
import { pacoteContabilidade } from './contabilidade.js';

/**
 * Captura de documentos da carteira: NF-e destinadas a cada cliente (Distribuição DF-e da SEFAZ, com o certificado A1
 * do cliente) e NFS-e emitidas pelo sistema. Uma tela para acompanhar todos os clientes de uma vez e baixar o pacote
 * do mês de cada um.
 */

const fimDoMes = (mes: string) => `${mes}-${String(new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5), 0)).getUTCDate()).padStart(2, '0')}`;

export function statusCaptura(escritorioId: number, mes: string, empresas: number[] | null = null) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  const de = `${mes}-01`, ate = fimDoMes(mes);
  const linhas = db.prepare(`SELECT e.id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.uf, e.cert_validade,
      (e.cert_pfx_enc IS NOT NULL) AS tem_certificado, d.ultima_consulta, d.proxima_consulta, d.ultimo_resultado, d.ultimo_erro, d.automatica,
      (d.empresa_id IS NOT NULL) AS iniciada,
      (SELECT COUNT(*) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ?) AS nfe_mes,
      (SELECT COUNT(*) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ? AND r.xml IS NULL AND r.situacao = 'AUTORIZADA') AS nfe_sem_xml,
      (SELECT COALESCE(SUM(r.valor),0) FROM nfe_recebidas r WHERE r.empresa_id = e.id AND substr(r.emissao,1,10) BETWEEN ? AND ? AND r.situacao = 'AUTORIZADA') AS nfe_valor,
      (SELECT COUNT(*) FROM notas n WHERE n.empresa_id = e.id AND n.ambiente = e.ambiente AND n.status IN ('AUTORIZADA','CANCELADA') AND n.competencia BETWEEN ? AND ?) AS nfse_mes
    FROM empresas e LEFT JOIN nfe_distribuicao d ON d.empresa_id = e.id
    WHERE e.escritorio_id = ? AND e.situacao != 'ENCERRADO' ${filtro} ORDER BY cliente`).all(de, ate, de, ate, de, ate, de, ate, escritorioId, ...(empresas ?? [])) as any[];
  const agora = new Date().toISOString();
  return linhas.map((l) => ({
    ...l, tem_certificado: !!l.tem_certificado, iniciada: !!l.iniciada, automatica: l.iniciada ? !!l.automatica : false,
    cert_vencido: l.cert_validade ? l.cert_validade < agora : false,
    pode_consultar: !!l.tem_certificado && !(l.cert_validade && l.cert_validade < agora) && (!l.proxima_consulta || l.proxima_consulta <= agora),
  }));
}

let capturaEmAndamento = false;

/** Consulta a SEFAZ para cada cliente que já pode (respeita o intervalo de 1 hora exigido quando não há documentos novos). */
export async function capturarTodos(escritorioId: number, empresas: number[] | null = null, buscar = buscarNaSefaz) {
  if (capturaEmAndamento) throw new ErroNegocio('Já há uma captura em andamento. Aguarde terminar.', 409);
  capturaEmAndamento = true;
  try {
    const alvo = statusCaptura(escritorioId, new Date().toISOString().slice(0, 7), empresas).filter((l) => l.pode_consultar);
    const resultados: { empresa_id: number; cliente: string; ok: boolean; novas: number; mensagem: string }[] = [];
    for (const l of alvo) {
      try {
        const r = await buscar(l.id);
        resultados.push({ empresa_id: l.id, cliente: l.cliente, ok: true, novas: r.novas ?? 0, mensagem: r.resumo ?? (r.aviso || 'Consulta feita.') });
      } catch (e: any) {
        resultados.push({ empresa_id: l.id, cliente: l.cliente, ok: false, novas: 0, mensagem: String(e?.message ?? e) });
      }
    }
    return { consultados: resultados.length, novas: resultados.reduce((s, r) => s + r.novas, 0), erros: resultados.filter((r) => !r.ok).length, resultados };
  } finally { capturaEmAndamento = false; }
}

/** Liga (ou desliga) a captura automática de NF-e para todos os clientes com certificado. */
export function automaticaParaTodos(escritorioId: number, ligar: boolean, empresas: number[] | null = null) {
  const alvo = statusCaptura(escritorioId, new Date().toISOString().slice(0, 7), empresas).filter((l) => l.tem_certificado);
  for (const l of alvo) configurarBusca(l.id, ligar);
  return { alterados: alvo.length };
}

/** Pacote do mês do cliente: NFS-e emitidas (XML) e NF-e recebidas (lançadas e as baixadas da SEFAZ), com planilhas. */
export function pacoteDoMes(empresaId: number, mes: string) {
  return pacoteContabilidade(empresaId, { de: `${mes}-01`, ate: fimDoMes(mes), xml: true, pdf: false, ofx: false, entradas: true, sefaz: true });
}
