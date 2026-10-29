import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { soDigitos } from '../nfse/validacao.js';

/**
 * Senhas e acessos dos clientes: código de acesso do Simples Nacional (com o CPF do responsável e a atividade) e a
 * senha previdenciária. Os segredos ficam criptografados no banco e só aparecem quando alguém clica em "Mostrar".
 */

export const Acesso = z.object({
  sn_cpf_responsavel: z.string().nullish().transform((v) => (v ? soDigitos(v) || null : null)).refine((v) => !v || v.length === 11, 'CPF do responsável deve ter 11 dígitos'),
  /** undefined = mantém o que está guardado; '' ou null = apaga. */
  sn_codigo: z.string().trim().max(40).nullish(),
  sn_atividade: z.string().trim().max(120).nullish().transform((v) => v || null),
  prev_senha: z.string().trim().max(60).nullish(),
  observacoes: z.string().trim().max(500).nullish().transform((v) => v || null),
});

export function listarAcessos(escritorioId: number, empresas: number[] | null = null) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  return (db.prepare(`SELECT e.id AS empresa_id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.razao_social, e.documento, e.regime, e.situacao,
      a.sn_cpf_responsavel, a.sn_atividade, a.observacoes, (a.sn_codigo_enc IS NOT NULL) AS tem_codigo, (a.prev_senha_enc IS NOT NULL) AS tem_prev, a.atualizado_em
    FROM empresas e LEFT JOIN acessos_cliente a ON a.empresa_id = e.id
    WHERE e.escritorio_id = ? AND (e.na_carteira = 1 OR e.eh_escritorio = 1) ${filtro} ORDER BY e.situacao != 'ATIVO', COALESCE(e.nome_fantasia, e.razao_social)`).all(escritorioId, ...(empresas ?? [])) as any[])
    .map((l) => ({ ...l, tem_codigo: !!l.tem_codigo, tem_prev: !!l.tem_prev }));
}

export function salvarAcesso(escritorioId: number, usuarioId: number, empresaId: number, d: z.infer<typeof Acesso>) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  const atual = db.prepare('SELECT * FROM acessos_cliente WHERE empresa_id = ?').get(empresaId) as any;
  const seg = (novo: string | null | undefined, antigo: string | null) => (novo === undefined ? antigo : novo ? cifrarTexto(novo) : null);
  db.prepare(`INSERT INTO acessos_cliente (empresa_id, sn_cpf_responsavel, sn_codigo_enc, sn_atividade, prev_senha_enc, observacoes, usuario_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(empresa_id) DO UPDATE SET sn_cpf_responsavel = excluded.sn_cpf_responsavel, sn_codigo_enc = excluded.sn_codigo_enc, sn_atividade = excluded.sn_atividade,
      prev_senha_enc = excluded.prev_senha_enc, observacoes = excluded.observacoes, usuario_id = excluded.usuario_id, atualizado_em = datetime('now')`)
    .run(empresaId, d.sn_cpf_responsavel ?? null, seg(d.sn_codigo, atual?.sn_codigo_enc ?? null), d.sn_atividade ?? null, seg(d.prev_senha, atual?.prev_senha_enc ?? null), d.observacoes ?? null, usuarioId);
  return { ok: true };
}

/** Mostra os segredos de um cliente (quem tem acesso a "Senhas e acessos"). */
export function revelarAcesso(escritorioId: number, empresaId: number) {
  const a = db.prepare('SELECT a.* FROM acessos_cliente a JOIN empresas e ON e.id = a.empresa_id WHERE a.empresa_id = ? AND e.escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!a) throw new ErroNegocio('Nenhum acesso guardado para este cliente.', 404);
  return { sn_codigo: a.sn_codigo_enc ? decifrarTexto(a.sn_codigo_enc) : null, prev_senha: a.prev_senha_enc ? decifrarTexto(a.prev_senha_enc) : null };
}
