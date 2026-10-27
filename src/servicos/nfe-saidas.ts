import { db } from '../db.js';
import { lerNfe } from '../nfe/leitura.js';
import { EVENTOS_CANCELAMENTO, lerDocumento, type DocDistribuido } from '../nfe/sefaz-an.js';
import { ErroNegocio } from './emissao.js';

/**
 * NF-e de venda dos clientes, recebidas pelo certificado do escritório.
 *
 * Quando o cliente põe o CNPJ do escritório no grupo autXML ("autorizados a obter o XML") da nota, a SEFAZ entrega o
 * XML completo também ao escritório, na mesma Distribuição DF-e usada para as compras. Na busca da empresa do
 * escritório, as notas em que ele não é o destinatário vêm para cá e são ligadas ao cliente pelo CNPJ do emitente.
 */

const dataEmi = (s?: string | null) => (s ? s.slice(0, 10) : null);

/**
 * Decide se o documento da busca do escritório é uma nota de venda de cliente (e guarda) ou segue o fluxo normal de compras.
 * Retorna null quando não é com ela.
 */
export function rotearSaida(empresaId: number, d: DocDistribuido): 'completa' | 'cancelamento' | null {
  const esc = db.prepare('SELECT id, escritorio_id, documento, eh_escritorio FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!esc?.eh_escritorio) return null;
  if (d.tipo === 'procNFe') {
    let n: ReturnType<typeof lerNfe>;
    try { n = lerNfe(d.xml); } catch { return null; }
    if (n.destinatario.documento === esc.documento) return null; // compra do próprio escritório
    const cStat = d.xml.match(/<cStat>(\d+)<\/cStat>/)?.[1];
    const situacao = cStat && ['110', '205', '301', '302', '303'].includes(cStat) ? 'DENEGADA' : 'AUTORIZADA';
    db.prepare(`INSERT INTO nfe_saidas (escritorio_id, chave, emitente_documento, emitente_nome, numero, serie, modelo, natureza, emissao, destinatario_documento, destinatario_nome, valor, situacao, xml, nsu)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(escritorio_id, chave) DO UPDATE SET emitente_nome = excluded.emitente_nome, numero = excluded.numero, serie = excluded.serie, modelo = excluded.modelo,
        natureza = excluded.natureza, emissao = excluded.emissao, destinatario_documento = excluded.destinatario_documento, destinatario_nome = excluded.destinatario_nome,
        valor = excluded.valor, xml = excluded.xml, nsu = excluded.nsu,
        situacao = CASE WHEN nfe_saidas.situacao = 'CANCELADA' THEN 'CANCELADA' ELSE excluded.situacao END`)
      .run(esc.escritorio_id, n.chave, n.fornecedor.documento, n.fornecedor.nome, n.numero, n.serie, n.modelo, n.natureza ?? null, dataEmi(n.emissao),
        n.destinatario.documento ?? null, n.destinatario.nome ?? null, n.totais.nf, situacao, d.xml, d.nsu);
    return 'completa';
  }
  if (d.tipo === 'resEvento' || d.tipo === 'procEventoNFe') {
    const c = lerDocumento(d.xml);
    const chave = c.chNFe;
    if (!EVENTOS_CANCELAMENTO.includes(c.tpEvento) || !/^\d{44}$/.test(chave ?? '')) return null;
    if (db.prepare("UPDATE nfe_saidas SET situacao = 'CANCELADA' WHERE escritorio_id = ? AND chave = ?").run(esc.escritorio_id, chave).changes) return 'cancelamento';
    if (db.prepare('SELECT 1 FROM nfe_recebidas WHERE empresa_id = ? AND chave = ?').get(empresaId, chave)) return null; // compra do escritório
    // cancelamento antes da nota: se o emitente é cliente da carteira (e não o escritório), já deixa a marca
    const emitente = chave.slice(6, 20);
    if (emitente !== esc.documento && db.prepare('SELECT 1 FROM empresas WHERE escritorio_id = ? AND documento = ?').get(esc.escritorio_id, emitente)) {
      db.prepare(`INSERT INTO nfe_saidas (escritorio_id, chave, emitente_documento, numero, serie, situacao) VALUES (?,?,?,?,?,'CANCELADA')
        ON CONFLICT(escritorio_id, chave) DO UPDATE SET situacao = 'CANCELADA'`).run(esc.escritorio_id, chave, emitente, String(Number(chave.slice(25, 34))), String(Number(chave.slice(22, 25))));
      return 'cancelamento';
    }
  }
  return null;
}

export function listarSaidas(escritorioId: number, documento: string, de: string, ate: string) {
  return db.prepare(`SELECT id, chave, numero, serie, modelo, natureza, emissao, destinatario_documento, destinatario_nome, valor, situacao FROM nfe_saidas
    WHERE escritorio_id = ? AND emitente_documento = ? AND xml IS NOT NULL AND emissao BETWEEN ? AND ? ORDER BY emissao, CAST(numero AS INTEGER)`).all(escritorioId, documento, de, ate);
}

export function xmlSaida(escritorioId: number, chave: string) {
  const r = db.prepare('SELECT xml, numero, emitente_documento FROM nfe_saidas WHERE escritorio_id = ? AND chave = ?').get(escritorioId, chave) as any;
  if (!r?.xml) throw new ErroNegocio('XML não encontrado.', 404);
  return r as { xml: string; numero: string; emitente_documento: string };
}

/** Notas recebidas pelo autXML cujo emitente não está na carteira (para o escritório saber que existem). */
export function saidasForaDaCarteira(escritorioId: number, de: string, ate: string) {
  return db.prepare(`SELECT s.emitente_documento, MAX(s.emitente_nome) AS emitente_nome, COUNT(*) AS notas, SUM(s.valor) AS total FROM nfe_saidas s
    WHERE s.escritorio_id = ? AND s.xml IS NOT NULL AND s.emissao BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM empresas e WHERE e.escritorio_id = s.escritorio_id AND e.documento = s.emitente_documento)
    GROUP BY s.emitente_documento ORDER BY notas DESC`).all(escritorioId, de, ate) as { emitente_documento: string; emitente_nome: string | null; notas: number; total: number }[];
}
