import { db } from '../db.js';
import { lerNfe } from '../nfe/leitura.js';
import { ErroNegocio } from './emissao.js';

/**
 * Conferência fiscal do mês de um cliente, feita com os documentos já capturados (nada é consultado na hora):
 * NF-e de entrada e de saída somadas por CFOP (pelo XML) e o resumo das NFS-e prestadas e tomadas.
 * Serve para o fiscal conferir o fechamento antes de escriturar; não substitui a escrituração.
 */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fimDoMes = (mes: string) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };

/** O 1º dígito do CFOP diz o sentido e a origem/destino (tabela de CFOP do Convênio s/nº de 1970). */
const ORIGEM_CFOP: Record<string, string> = {
  '1': 'Entrada do estado', '2': 'Entrada de outro estado', '3': 'Entrada do exterior',
  '5': 'Saída para o estado', '6': 'Saída para outro estado', '7': 'Saída para o exterior',
};

export interface LinhaCfop { cfop: string; origem: string; notas: number; itens: number; valor: number }
interface Bloco { notas: number; canceladas: number; semXml: number; valorProdutos: number; icms: number; icmsSt: number; ipi: number; totalNotas: number; cfops: LinhaCfop[] }
interface ResumoNfse { notas: number; canceladas: number; valor: number; iss: number; issRetido: number; liquido: number }

function somarNotas(l: { chave: string; situacao: string; xml: string | null }[]): Bloco {
  const b: Bloco = { notas: 0, canceladas: 0, semXml: 0, valorProdutos: 0, icms: 0, icmsSt: 0, ipi: 0, totalNotas: 0, cfops: [] };
  const por = new Map<string, LinhaCfop & { chaves: Set<string> }>();
  for (const n of l) {
    if (n.situacao !== 'AUTORIZADA') { b.canceladas++; continue; }
    if (!n.xml) { b.semXml++; continue; }
    let nf; try { nf = lerNfe(n.xml); } catch { b.semXml++; continue; }
    b.notas++;
    b.valorProdutos += nf.totais.produtos; b.icms += nf.totais.icms; b.icmsSt += nf.totais.icmsSt; b.ipi += nf.totais.ipi; b.totalNotas += nf.totais.nf;
    for (const it of nf.itens) {
      const cfop = (it.cfop ?? '').replace(/\D/g, '') || 'sem CFOP';
      const x = por.get(cfop) ?? { cfop, origem: ORIGEM_CFOP[cfop[0]] ?? '—', notas: 0, itens: 0, valor: 0, chaves: new Set<string>() };
      x.itens++; x.valor += it.valor - (it.desconto ?? 0); x.chaves.add(nf.chave); por.set(cfop, x);
    }
  }
  b.cfops = [...por.values()].map(({ chaves, ...x }) => ({ ...x, notas: chaves.size, valor: r2(x.valor) })).sort((a, z) => a.cfop.localeCompare(z.cfop));
  for (const k of ['valorProdutos', 'icms', 'icmsSt', 'ipi', 'totalNotas'] as const) b[k] = r2(b[k]);
  return b;
}

function resumoNfse(l: any[]): ResumoNfse {
  const ok = l.filter((n) => n.situacao !== 'CANCELADA');
  const s = (k: string) => r2(ok.reduce((t, n) => t + (Number(n[k]) || 0), 0));
  return { notas: ok.length, canceladas: l.length - ok.length, valor: s('valor'), iss: s('iss'), issRetido: r2(ok.filter((n) => n.iss_retido).reduce((t, n) => t + (Number(n.iss) || 0), 0)), liquido: s('valor_liquido') };
}

export function conferenciaFiscal(escritorioId: number, empresaId: number, mes: string) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErroNegocio('Informe o mês (AAAA-MM).');
  const e = db.prepare('SELECT id, documento, razao_social FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const de = `${mes}-01`, ate = fimDoMes(mes);
  const entradas = db.prepare(`SELECT chave, situacao, xml FROM nfe_recebidas WHERE empresa_id = ? AND oculta = 0 AND substr(emissao, 1, 10) BETWEEN ? AND ?`).all(empresaId, de, ate) as any[];
  const saidas = db.prepare(`SELECT chave, situacao, xml FROM nfe_saidas WHERE escritorio_id = ? AND emitente_documento = ? AND substr(emissao, 1, 10) BETWEEN ? AND ?`).all(escritorioId, e.documento, de, ate) as any[];
  const nfse = db.prepare(`SELECT papel, situacao, valor, valor_liquido, iss, iss_retido FROM nfse_capturadas WHERE empresa_id = ? AND substr(competencia, 1, 10) BETWEEN ? AND ?`).all(empresaId, de, ate) as any[];
  return {
    cliente: e.razao_social, mes,
    entradas: somarNotas(entradas), saidas: somarNotas(saidas),
    nfsePrestadas: resumoNfse(nfse.filter((n) => n.papel !== 'TOMADOR')), nfseTomadas: resumoNfse(nfse.filter((n) => n.papel === 'TOMADOR')),
  };
}

/** A conferência em CSV (Excel), para o pacote do mês. */
export function conferenciaCsv(c: ReturnType<typeof conferenciaFiscal>) {
  const br = (n: number) => n.toFixed(2).replace('.', ',');
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const l: string[] = [['Sentido', 'CFOP', 'Origem/destino', 'Notas', 'Itens', 'Valor dos itens'].map(q).join(';')];
  for (const [nome, b] of [['Entrada', c.entradas], ['Saída', c.saidas]] as const) for (const x of b.cfops) l.push([nome, x.cfop, x.origem, x.notas, x.itens, br(x.valor)].map(q).join(';'));
  l.push('', ['NFS-e', 'Notas', 'Canceladas', 'Valor', 'ISS', 'ISS retido', 'Líquido'].map(q).join(';'));
  for (const [nome, r] of [['Prestadas', c.nfsePrestadas], ['Tomadas', c.nfseTomadas]] as const) l.push([nome, r.notas, r.canceladas, br(r.valor), br(r.iss), br(r.issRetido), br(r.liquido)].map(q).join(';'));
  return '﻿' + l.join('\r\n');
}
