import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { limparDoc } from '../nfse/validacao.js';

/**
 * Controle de certificados e procurações da carteira.
 * Junta duas fontes: os certificados A1 guardados no sistema (cadastro da empresa, usados para emitir e buscar NF-e)
 * e os cadastrados à mão (A3 em token/cartão, e-CPF de sócios, procurações eletrônicas no e-CAC etc.).
 */

export const TIPOS_CERT = { A1: 'Certificado A1', A3: 'Certificado A3 (token/cartão)', ECPF: 'e-CPF (sócio/responsável)', PROCURACAO: 'Procuração eletrônica', OUTRO: 'Outro' } as const;

export const Certificado = z.object({
  empresa_id: z.number().int().positive().nullish(),
  tipo: z.enum(['A1', 'A3', 'ECPF', 'PROCURACAO', 'OUTRO']),
  titular: z.string().trim().min(2).max(200),
  documento: z.string().nullish().transform((d) => (d ? limparDoc(d) : null)),
  validade: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a validade'),
  emissor: z.string().trim().max(120).nullish(),
  guarda: z.string().trim().max(200).nullish(),
  observacoes: z.string().trim().max(1000).nullish(),
  renovado: z.boolean().default(false),
});
export type Certificado = z.infer<typeof Certificado>;

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
export type SituacaoCert = 'VENCIDO' | 'VENCE_7' | 'VENCE_30' | 'OK' | 'RENOVADO';

export function situacaoCert(validade: string, renovado: boolean, hoje = hojeBr()): { situacao: SituacaoCert; dias: number } {
  const dias = Math.round((Date.parse(validade.slice(0, 10)) - Date.parse(hoje)) / 864e5);
  if (renovado) return { situacao: 'RENOVADO', dias };
  return { situacao: dias < 0 ? 'VENCIDO' : dias <= 7 ? 'VENCE_7' : dias <= 30 ? 'VENCE_30' : 'OK', dias };
}

export interface LinhaCert {
  chave: string; id: number | null; origem: 'SISTEMA' | 'CADASTRO'; empresa_id: number | null; cliente: string | null; documento_cliente: string | null;
  tipo: string; titular: string; documento: string | null; validade: string; emissor: string | null; guarda: string | null; observacoes: string | null;
  renovado: boolean; situacao: SituacaoCert; dias: number;
}

/** Todos os certificados do escritório, do que vence primeiro para o último. */
export function listarCertificados(escritorioId: number, hoje = hojeBr()): LinhaCert[] {
  const doSistema = db.prepare(`SELECT id, COALESCE(nome_fantasia, razao_social) AS cliente, documento, cert_titular, cert_validade FROM empresas
    WHERE escritorio_id = ? AND cert_pfx_enc IS NOT NULL AND cert_validade IS NOT NULL AND situacao != 'ENCERRADO'`).all(escritorioId) as any[];
  const cadastrados = db.prepare(`SELECT c.*, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento AS documento_cliente FROM certificados c
    LEFT JOIN empresas e ON e.id = c.empresa_id WHERE c.escritorio_id = ?`).all(escritorioId) as any[];
  const lista: LinhaCert[] = [
    ...doSistema.map((e): LinhaCert => ({
      chave: `e${e.id}`, id: null, origem: 'SISTEMA', empresa_id: e.id, cliente: e.cliente, documento_cliente: e.documento,
      tipo: 'A1', titular: e.cert_titular ?? e.cliente, documento: e.documento, validade: String(e.cert_validade).slice(0, 10),
      emissor: null, guarda: 'Guardado no sistema (emissão e busca de NF-e)', observacoes: null, renovado: false, ...situacaoCert(String(e.cert_validade), false, hoje),
    })),
    ...cadastrados.map((c): LinhaCert => ({
      chave: `c${c.id}`, id: c.id, origem: 'CADASTRO', empresa_id: c.empresa_id, cliente: c.cliente ?? null, documento_cliente: c.documento_cliente ?? null,
      tipo: c.tipo, titular: c.titular, documento: c.documento, validade: c.validade, emissor: c.emissor, guarda: c.guarda, observacoes: c.observacoes,
      renovado: !!c.renovado, ...situacaoCert(c.validade, !!c.renovado, hoje),
    })),
  ];
  const ordem: Record<SituacaoCert, number> = { VENCIDO: 0, VENCE_7: 1, VENCE_30: 2, OK: 3, RENOVADO: 4 };
  return lista.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || a.validade.localeCompare(b.validade));
}

export function resumoCertificados(lista: LinhaCert[]) {
  return {
    vencidos: lista.filter((c) => c.situacao === 'VENCIDO').length,
    vence7: lista.filter((c) => c.situacao === 'VENCE_7').length,
    vence30: lista.filter((c) => c.situacao === 'VENCE_30').length,
    ok: lista.filter((c) => c.situacao === 'OK').length,
  };
}

function conferirEmpresa(escritorioId: number, empresaId?: number | null) {
  if (empresaId && !db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
}

export function salvarCertificado(escritorioId: number, id: number | null, d: Certificado) {
  conferirEmpresa(escritorioId, d.empresa_id);
  const campos = [d.empresa_id ?? null, d.tipo, d.titular, d.documento ?? null, d.validade, d.emissor ?? null, d.guarda ?? null, d.observacoes ?? null, d.renovado ? 1 : 0];
  if (id == null) {
    return Number(db.prepare('INSERT INTO certificados (empresa_id, tipo, titular, documento, validade, emissor, guarda, observacoes, renovado, escritorio_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...campos, escritorioId).lastInsertRowid);
  }
  const r = db.prepare('UPDATE certificados SET empresa_id=?, tipo=?, titular=?, documento=?, validade=?, emissor=?, guarda=?, observacoes=?, renovado=? WHERE id = ? AND escritorio_id = ?').run(...campos, id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Certificado não encontrado.', 404);
  return id;
}

/** Renovação: o antigo sai dos avisos e nasce o novo com a nova validade (o histórico fica). */
export function renovarCertificado(escritorioId: number, id: number, validade: string, observacoes?: string | null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validade)) throw new ErroNegocio('Informe a nova validade.');
  const c = db.prepare('SELECT * FROM certificados WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!c) throw new ErroNegocio('Certificado não encontrado.', 404);
  return db.transaction(() => {
    db.prepare('UPDATE certificados SET renovado = 1 WHERE id = ?').run(id);
    return Number(db.prepare('INSERT INTO certificados (escritorio_id, empresa_id, tipo, titular, documento, validade, emissor, guarda, observacoes) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(escritorioId, c.empresa_id, c.tipo, c.titular, c.documento, validade, c.emissor, c.guarda, observacoes ?? c.observacoes).lastInsertRowid);
  })();
}

export function excluirCertificado(escritorioId: number, id: number) {
  const r = db.prepare('DELETE FROM certificados WHERE id = ? AND escritorio_id = ?').run(id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Certificado não encontrado.', 404);
}
