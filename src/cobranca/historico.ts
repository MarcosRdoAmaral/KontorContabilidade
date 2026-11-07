// ---------------------------------------------------------------------------
// Histórico da cobrança, arquivos de retorno, ocorrências do banco e liquidações.
// Comum a todos os bancos: nada aqui conhece um banco específico.
// As mudanças de situação, valor e vencimento entram no histórico sozinhas (gatilhos no banco de dados);
// este módulo registra o que a situação não mostra: quem pediu, o arquivo, a ocorrência original do banco.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ErroNegocio } from '../servicos/emissao.js';

export type OrigemEvento = 'TELA' | 'REMESSA' | 'RETORNO' | 'BANCO_API' | 'SISTEMA';

export function registrarEvento(e: { cobrancaId: number; tipo: string; origem: OrigemEvento; usuarioId?: number | null; de?: string | null; para?: string | null; dados?: unknown }) {
  db.prepare('INSERT INTO eventos_cobranca (cobranca_id, tipo, de, para, origem, usuario_id, dados) VALUES (?,?,?,?,?,?,?)')
    .run(e.cobrancaId, e.tipo, e.de ?? null, e.para ?? null, e.origem, e.usuarioId ?? null, e.dados === undefined ? null : JSON.stringify(e.dados));
}

/** Retorno guardado por inteiro; o mesmo arquivo (mesmo conteúdo) não é processado duas vezes. */
export function guardarArquivoRetorno(empresaId: number, texto: string, d: { nome?: string | null; contaRef?: string; usuarioId?: number | null }) {
  const normal = texto.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const hash = crypto.createHash('sha256').update(normal).digest('hex');
  const ja = db.prepare('SELECT processado_em FROM arquivos_retorno WHERE empresa_id = ? AND hash = ?').get(empresaId, hash) as { processado_em: string } | undefined;
  if (ja) {
    const [a, m, dd] = ja.processado_em.slice(0, 10).split('-');
    throw new ErroNegocio(`Este arquivo de retorno já foi importado em ${dd}/${m}/${a}. Nada foi alterado.`, 409);
  }
  const r = db.prepare('INSERT INTO arquivos_retorno (empresa_id, conta_ref, nome, hash, conteudo, usuario_id) VALUES (?,?,?,?,?,?)')
    .run(empresaId, d.contaRef ?? '', d.nome ?? null, hash, texto, d.usuarioId ?? null);
  return Number(r.lastInsertRowid);
}
export const contarItensRetorno = (id: number, itens: number) => db.prepare('UPDATE arquivos_retorno SET itens = ? WHERE id = ?').run(itens, id);

/** Ocorrência como o banco mandou (código e texto originais), sem duplicar a mesma ocorrência do mesmo evento. */
export function registrarOcorrencia(o: { cobrancaId: number; codigo: string; descricao: string; motivos?: string | null; estadoMapeado?: string | null; dataEvento?: string | null; fonte: string; arquivoRetornoId?: number | null; bruto?: string | null }): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO ocorrencias_bancarias (cobranca_id, codigo, descricao, motivos, estado_mapeado, data_evento, fonte, arquivo_retorno_id, bruto)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(o.cobrancaId, o.codigo, o.descricao, o.motivos ?? null, o.estadoMapeado ?? null, o.dataEvento ?? null, o.fonte, o.arquivoRetornoId ?? null, o.bruto ?? null);
  return r.changes > 0;
}

/** Liquidação única por chave (ex.: banco + nosso número + data + valor): a mesma liquidação nunca entra duas vezes. */
export function registrarLiquidacao(l: { cobrancaId: number; valorPago: number; tarifa?: number | null; dataPagamento?: string | null; dataCredito?: string | null; fonte: string; chave: string }): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO liquidacoes (cobranca_id, valor_pago, tarifa, data_pagamento, data_credito, fonte, chave) VALUES (?,?,?,?,?,?,?)')
    .run(l.cobrancaId, l.valorPago, l.tarifa ?? null, l.dataPagamento ?? null, l.dataCredito ?? null, l.fonte, l.chave);
  return r.changes > 0;
}

const ROTULO_SITUACAO: Record<string, string> = {
  AGUARDANDO_BANCO: 'Aguardando o banco', A_REMETER: 'A enviar ao banco', REMETIDO: 'Enviado ao banco', REGISTRADO: 'Registrado no banco',
  REJEITADO: 'Rejeitado pelo banco', PAGO: 'Pago', CANCELADO: 'Cancelado', EMITIDO: 'Emitido',
};
const rotulo = (s?: string | null) => (s ? ROTULO_SITUACAO[s] ?? s : '');
const brl = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '');
const dataBr = (iso: unknown) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : '');

/** Linha do tempo da cobrança: eventos, ocorrências do banco e liquidações, do mais antigo ao mais novo. */
export function historicoDaCobranca(cobrancaId: number) {
  const eventos = (db.prepare(`SELECT e.*, u.nome AS usuario FROM eventos_cobranca e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.cobranca_id = ? ORDER BY e.id`).all(cobrancaId) as any[])
    .map((e) => {
      const d = e.dados ? JSON.parse(e.dados) : {};
      let texto: string;
      switch (e.tipo) {
        case 'CRIADA': texto = `Cobrança criada: ${brl(d.valor)}, vencimento ${dataBr(d.vencimento)}`; break;
        case 'SITUACAO_INICIAL': texto = `Situação quando o histórico começou: ${rotulo(e.para)}`; break;
        case 'SITUACAO': texto = `${rotulo(e.de)} → ${rotulo(e.para)}${d.observacao ? ` (${d.observacao})` : ''}`; break;
        case 'ALTERACAO': {
          const p: string[] = [];
          if (d.valor_de !== d.valor_para) p.push(`valor ${brl(d.valor_de)} → ${brl(d.valor_para)}`);
          if (d.vencimento_de !== d.vencimento_para) p.push(`vencimento ${dataBr(d.vencimento_de)} → ${dataBr(d.vencimento_para)}`);
          texto = `Alteração: ${p.join('; ')}`; break;
        }
        default: texto = d.texto ?? e.tipo;
      }
      return { quando: e.criado_em, tipo: e.tipo, texto, origem: e.origem, usuario: e.usuario ?? null };
    });
  const ocorrencias = (db.prepare('SELECT * FROM ocorrencias_bancarias WHERE cobranca_id = ? ORDER BY id').all(cobrancaId) as any[])
    .map((o) => ({ quando: o.criado_em, tipo: 'OCORRENCIA', texto: `Banco: ${o.codigo} – ${o.descricao}${o.motivos ? ` (${o.motivos})` : ''}${o.data_evento ? `, em ${dataBr(o.data_evento)}` : ''}`, origem: o.fonte, usuario: null }));
  const liquidacoes = (db.prepare('SELECT * FROM liquidacoes WHERE cobranca_id = ? ORDER BY id').all(cobrancaId) as any[])
    .map((l) => ({ quando: l.criado_em, tipo: 'LIQUIDACAO', texto: `Pagamento de ${brl(l.valor_pago)}${l.data_pagamento ? ` em ${dataBr(l.data_pagamento)}` : ''}${l.tarifa ? `, tarifa ${brl(l.tarifa)}` : ''}`, origem: l.fonte, usuario: null }));
  return [...eventos, ...ocorrencias, ...liquidacoes].sort((a, b) => a.quando.localeCompare(b.quando));
}
