import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

/**
 * Controle mensal de entregas (o que antes ficava na planilha "Controle de Entregas"): por competência e por cliente,
 * a parte fiscal (faturamento, imposto, emissão e envio da guia), a de departamento pessoal (DARF previdenciário,
 * FGTS, sindicato) e a contábil (contabilização enviada).
 */

export const AREAS = ['FISCAL', 'DP', 'CONTABIL'] as const;
export type Area = (typeof AREAS)[number];

const valor = z.number().min(0).max(1e10).nullish();
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null));
const texto = (n: number) => z.string().trim().max(n).nullish().transform((v) => v || null);
export const DADOS: Record<Area, z.ZodTypeAny> = {
  FISCAL: z.object({ sem_movimento: z.boolean().nullish(), entradas: z.boolean().nullish(), saidas: z.boolean().nullish(), faturamento: valor, imposto: valor, emissao: data, enviado: data, observacoes: texto(500) }),
  DP: z.object({ sem_folha: z.boolean().nullish(), darf_prev: valor, fgts: valor, sindicato: valor, enviado: data, observacoes: texto(500) }),
  CONTABIL: z.object({ enviado: data, observacoes: texto(500) }),
};
export const LinhaControle = z.object({
  empresa_id: z.number().int().positive(), competencia: z.string().regex(/^\d{4}-\d{2}$/), area: z.enum(AREAS),
  dados: z.record(z.string(), z.any()), canal_envio: z.enum(['WHATSAPP', 'EMAIL', 'OUTRO']).nullish(), registro_dp: z.string().trim().max(20).nullish(), // ausentes = não mexe
});

export function listarControle(escritorioId: number, competencia: string, area: Area, empresas: number[] | null = null) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  const linhas = db.prepare(`SELECT e.id AS empresa_id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.regime, e.tem_funcionarios, e.canal_envio, e.registro_dp, e.email, e.contato_fone,
      c.dados_json, c.atualizado_em, u.nome AS usuario
    FROM empresas e LEFT JOIN controle_mensal c ON c.empresa_id = e.id AND c.competencia = ? AND c.area = ? LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE e.escritorio_id = ? AND e.na_carteira = 1 AND (e.situacao = 'ATIVO' OR c.id IS NOT NULL) ${filtro}
    ORDER BY COALESCE(e.nome_fantasia, e.razao_social)`).all(competencia, area, escritorioId, ...(empresas ?? [])) as any[];
  return linhas.map(({ dados_json, ...l }) => ({ ...l, tem_funcionarios: !!l.tem_funcionarios, dados: dados_json ? JSON.parse(dados_json) : {} }));
}

export function salvarLinha(escritorioId: number, usuarioId: number, d: z.infer<typeof LinhaControle>) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(d.empresa_id, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  const dados = DADOS[d.area].parse(d.dados);
  db.transaction(() => {
    db.prepare(`INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json, usuario_id) VALUES (?,?,?,?,?)
      ON CONFLICT(empresa_id, competencia, area) DO UPDATE SET dados_json = excluded.dados_json, usuario_id = excluded.usuario_id, atualizado_em = datetime('now')`)
      .run(d.empresa_id, d.competencia, d.area, JSON.stringify(dados), usuarioId);
    if (d.canal_envio !== undefined) db.prepare('UPDATE empresas SET canal_envio = ? WHERE id = ?').run(d.canal_envio ?? null, d.empresa_id);
    if (d.registro_dp !== undefined) db.prepare('UPDATE empresas SET registro_dp = ? WHERE id = ?').run(d.registro_dp || null, d.empresa_id);
  })();
  return { ok: true, dados };
}

/**
 * Lança no Controle mensal o valor de uma guia. Sem `sobrescrever`, não mexe no que já foi digitado; com ele (guia
 * acabou de ser emitida), o valor da guia substitui o anterior. A data de envio nunca é marcada aqui.
 */
export function lancarNoControle(empresaId: number, mes: string, area: Area, campo: string, valor: number | boolean | null, usuarioId: number | null, sobrescrever = false) {
  if (valor == null) return;
  const atual = db.prepare('SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = ? AND area = ?').get(empresaId, mes, area) as any;
  const d = atual ? JSON.parse(atual.dados_json) : {};
  if (d[campo] != null && (!sobrescrever || d[campo] === valor)) return;
  d[campo] = valor;
  if (area === 'FISCAL' && campo === 'imposto' && typeof valor === 'number' && valor > 0) d.emissao ??= new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json, usuario_id) VALUES (?,?,?,?,?)
    ON CONFLICT(empresa_id, competencia, area) DO UPDATE SET dados_json = excluded.dados_json, usuario_id = COALESCE(excluded.usuario_id, controle_mensal.usuario_id), atualizado_em = datetime('now')`)
    .run(empresaId, mes, area, JSON.stringify(d), usuarioId);
}
