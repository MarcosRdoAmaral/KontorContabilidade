import { db } from '../db.js';
import { lerNfse } from '../nfse/leitura.js';
import { consultaAdn, lerRespostaAdn, type ConsultaAdn, type DocAdn } from '../nfse/adn.js';
import { ErroNegocio, certificadoDaEmpresa } from './emissao.js';

/**
 * NFS-e prestadas e tomadas de cada cliente, baixadas do Ambiente de Dados Nacional (ADN) com o certificado A1 dele.
 * Cada consulta pede os documentos com NSU maior que o último guardado (até 50 por vez). Sem documentos novos,
 * espera 1 hora antes de consultar de novo (o ADN limita consultas seguidas).
 * Vale para os municípios que usam o padrão nacional; os que têm sistema próprio não mandam as notas para o ADN.
 */

const ESPERA_MS = 61 * 60_000;
const MAX_PAGINAS = 20;
const emAndamento = new Set<number>();
const esperaPorErro = new Map<number, number>();

export interface ResultadoAdn { consultou: boolean; prestadas: number; tomadas: number; cancelamentos: number; proximaConsulta: string | null; resumo: string }

function estado(empresaId: number) {
  db.prepare('INSERT OR IGNORE INTO adn_distribuicao (empresa_id) VALUES (?)').run(empresaId);
  return db.prepare('SELECT * FROM adn_distribuicao WHERE empresa_id = ?').get(empresaId) as { ult_nsu: number; proxima_consulta: string | null; automatica: number };
}

const raiz = (d?: string | null) => String(d ?? '').replace(/\D/g, '').slice(0, 8);
const num = (v: any) => (v == null || v === '' ? null : Number(v));

/** Papel do cliente na nota: prestador, tomador (documento completo; na falta, a raiz do CNPJ, para filiais) ou outro. */
export function papelNaNota(doc: string, prestador?: string | null, tomador?: string | null): 'PRESTADOR' | 'TOMADOR' | 'OUTRO' {
  if (prestador && prestador === doc) return 'PRESTADOR';
  if (tomador && tomador === doc) return 'TOMADOR';
  if (doc.length === 14 && prestador?.length === 14 && raiz(prestador) === raiz(doc)) return 'PRESTADOR';
  if (doc.length === 14 && tomador?.length === 14 && raiz(tomador) === raiz(doc)) return 'TOMADOR';
  return 'OUTRO';
}

const EVENTO_CANCELA = /<e101101[\s>]|<e105102[\s>]|<e101103[\s>]/;

/** Guarda um documento do ADN. Retorna o que ele representou. */
export function processarDocAdn(empresa: { id: number; documento: string }, d: DocAdn): 'PRESTADOR' | 'TOMADOR' | 'OUTRO' | 'CANCELAMENTO' | 'IGNORADO' {
  const evento = d.tipoDocumento.includes('EVENTO') || /<evento[\s>]/.test(d.xml) && !/<NFSe[\s>]/.test(d.xml);
  if (evento) {
    const chave = d.chave ?? d.xml.match(/<chNFSe>(\d{50})<\/chNFSe>/)?.[1] ?? null;
    const cancela = EVENTO_CANCELA.test(d.xml) || /cancel/i.test(d.tipoEvento ?? '') || /^(101101|105102|101103)$/.test(d.tipoEvento ?? '');
    if (!chave || !cancela) return 'IGNORADO';
    const r = db.prepare("UPDATE nfse_capturadas SET situacao = 'CANCELADA' WHERE empresa_id = ? AND chave = ?").run(empresa.id, chave);
    if (!r.changes) {
      // o cancelamento chegou antes da nota: guarda a marca para a nota já nascer cancelada
      db.prepare("INSERT OR IGNORE INTO nfse_capturadas (empresa_id, chave, papel, situacao, nsu) VALUES (?,?,'OUTRO','CANCELADA',?)").run(empresa.id, chave, d.nsu);
    }
    return 'CANCELAMENTO';
  }
  let n: ReturnType<typeof lerNfse>;
  try { n = lerNfse(d.xml); } catch { return 'IGNORADO'; }
  const chave = n.chave || d.chave;
  if (!chave) return 'IGNORADO';
  const prest = n.emitente?.documento ?? null, toma = n.tomador?.documento ?? null;
  const papel = papelNaNota(empresa.documento, prest, toma);
  const competencia = n.dps.dCompet || d.xml.match(/<dCompet>(\d{4}-\d{2}-\d{2})<\/dCompet>/)?.[1] || (n.dps.dhEmi ?? n.dhProc ?? '').slice(0, 10);
  const issRetido = n.valores.tpRetISSQN === '2' || n.valores.tpRetISSQN === '3' ? 1 : 0;
  db.prepare(`INSERT INTO nfse_capturadas (empresa_id, chave, papel, numero, emissao, competencia, prestador_documento, prestador_nome, tomador_documento, tomador_nome,
      municipio, descricao, valor, valor_liquido, iss, iss_retido, xml, nsu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(empresa_id, chave) DO UPDATE SET papel = excluded.papel, numero = excluded.numero, emissao = excluded.emissao, competencia = excluded.competencia,
      prestador_documento = excluded.prestador_documento, prestador_nome = excluded.prestador_nome, tomador_documento = excluded.tomador_documento, tomador_nome = excluded.tomador_nome,
      municipio = excluded.municipio, descricao = excluded.descricao, valor = excluded.valor, valor_liquido = excluded.valor_liquido, iss = excluded.iss,
      iss_retido = excluded.iss_retido, xml = excluded.xml, nsu = excluded.nsu`)
    .run(empresa.id, chave, papel, n.numero ?? null, (n.dps.dhEmi ?? n.dhProc ?? '').slice(0, 10) || null, competencia || null, prest, n.emitente?.nome ?? null, toma, n.tomador?.nome ?? null,
      n.xLocPrestacao ?? n.xLocEmi ?? null, n.servico?.descricao ?? null, num(n.valores.vServ), num(n.valores.vLiq), num(n.valores.vISSQN), issRetido, d.xml, d.nsu);
  return papel;
}

/** Busca as NFS-e novas do cliente no ADN. `consultar` permite trocar a conexão nos testes. */
export async function buscarNoAdn(empresaId: number, opcoes: { consultar?: ConsultaAdn; automatica?: boolean } = {}): Promise<ResultadoAdn> {
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!empresa) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (!opcoes.consultar && !empresa.cert_pfx_enc) throw new ErroNegocio('Para buscar as NFS-e no Ambiente Nacional, cadastre o certificado A1 do cliente em Empresas > Certificado.');
  if (emAndamento.has(empresaId)) throw new ErroNegocio('Já há uma busca de NFS-e em andamento para este cliente.', 409);
  const est = estado(empresaId);
  const res: ResultadoAdn = { consultou: false, prestadas: 0, tomadas: 0, cancelamentos: 0, proximaConsulta: est.proxima_consulta, resumo: '' };
  if (est.proxima_consulta && new Date(est.proxima_consulta).getTime() > Date.now()) {
    res.resumo = 'aguardando o intervalo do Ambiente Nacional';
    return res;
  }
  emAndamento.add(empresaId);
  let conexao: { consultar: ConsultaAdn; fechar: () => void } | null = null;
  try {
    const consultar = opcoes.consultar ?? (conexao = consultaAdn(certificadoDaEmpresa(empresa))).consultar;
    let nsu = Number(est.ult_nsu) || 0;
    let fimDaFila = false;
    res.consultou = true;
    for (let pag = 0; pag < MAX_PAGINAS; pag++) {
      const resp = await consultar(nsu);
      const r = lerRespostaAdn(resp.status, resp.corpo);
      if (r.situacao === 'NENHUM') { fimDaFila = true; break; }
      if (r.situacao === 'LIMITE') { fimDaFila = true; break; }
      if (r.situacao !== 'DOCUMENTOS') throw new ErroNegocio(`Ambiente Nacional da NFS-e: ${r.erros.join('; ')}`, 502);
      db.transaction(() => {
        for (const d of r.docs) {
          const o = processarDocAdn(empresa, d);
          if (o === 'PRESTADOR') res.prestadas++; else if (o === 'TOMADOR') res.tomadas++; else if (o === 'CANCELAMENTO') res.cancelamentos++;
        }
        nsu = Math.max(nsu, ...r.docs.map((d) => d.nsu));
        db.prepare('UPDATE adn_distribuicao SET ult_nsu = ? WHERE empresa_id = ?').run(nsu, empresaId);
      })();
      if (r.docs.length < 50) { fimDaFila = true; break; }
    }
    const partes = [res.prestadas && `${res.prestadas} prestada(s)`, res.tomadas && `${res.tomadas} tomada(s)`, res.cancelamentos && `${res.cancelamentos} cancelamento(s)`].filter(Boolean);
    res.resumo = partes.length ? `NFS-e: ${partes.join(', ')}` : 'NFS-e: nenhuma nota nova';
    // fila esgotada: só volta a consultar depois do intervalo; ainda há documentos: libera a próxima consulta já
    res.proximaConsulta = fimDaFila ? new Date(Date.now() + ESPERA_MS).toISOString() : null;
    db.prepare("UPDATE adn_distribuicao SET ultima_consulta = datetime('now'), proxima_consulta = ?, ultimo_resultado = ?, ultimo_erro = NULL WHERE empresa_id = ?")
      .run(res.proximaConsulta, res.resumo, empresaId);
    esperaPorErro.delete(empresaId);
    return res;
  } catch (e: any) {
    const msg = e instanceof ErroNegocio ? e.message : `Não foi possível consultar o Ambiente Nacional da NFS-e: ${e?.message ?? e}`;
    db.prepare("UPDATE adn_distribuicao SET ultima_consulta = datetime('now'), ultimo_erro = ? WHERE empresa_id = ?").run(msg, empresaId);
    if (opcoes.automatica) esperaPorErro.set(empresaId, Date.now() + 3 * 3600e3);
    throw e instanceof ErroNegocio ? e : new ErroNegocio(msg, 502);
  } finally {
    conexao?.fechar();
    emAndamento.delete(empresaId);
  }
}

export function configurarAdn(empresaId: number, automatica: boolean) {
  estado(empresaId);
  db.prepare('UPDATE adn_distribuicao SET automatica = ? WHERE empresa_id = ?').run(automatica ? 1 : 0, empresaId);
}

/** Chamada de tempos em tempos pelo servidor: clientes com a busca ligada, certificado válido e intervalo cumprido. */
export async function buscarAdnAutomaticamente(): Promise<void> {
  const agora = new Date().toISOString();
  const empresas = db.prepare(`SELECT a.empresa_id FROM adn_distribuicao a JOIN empresas e ON e.id = a.empresa_id
    WHERE a.automatica = 1 AND e.situacao != 'ENCERRADO' AND e.cert_pfx_enc IS NOT NULL AND (e.cert_validade IS NULL OR e.cert_validade > ?)
      AND (a.proxima_consulta IS NULL OR a.proxima_consulta <= ?)`).all(agora, agora) as { empresa_id: number }[];
  for (const { empresa_id } of empresas) {
    if ((esperaPorErro.get(empresa_id) ?? 0) > Date.now()) continue;
    try { await buscarNoAdn(empresa_id, { automatica: true }); } catch { /* erro registrado em adn_distribuicao */ }
  }
}

export function listarNfseCapturadas(empresaId: number, de: string, ate: string) {
  return db.prepare(`SELECT id, chave, papel, numero, emissao, competencia, prestador_documento, prestador_nome, tomador_documento, tomador_nome, municipio, descricao,
      valor, valor_liquido, iss, iss_retido, situacao, (xml IS NOT NULL) AS tem_xml
    FROM nfse_capturadas WHERE empresa_id = ? AND xml IS NOT NULL AND competencia BETWEEN ? AND ? ORDER BY competencia, numero`).all(empresaId, de, ate);
}

export function xmlNfseCapturada(empresaId: number, chave: string) {
  const r = db.prepare('SELECT xml, numero FROM nfse_capturadas WHERE empresa_id = ? AND chave = ?').get(empresaId, chave) as any;
  if (!r?.xml) throw new ErroNegocio('XML não encontrado.', 404);
  return r as { xml: string; numero: string };
}
