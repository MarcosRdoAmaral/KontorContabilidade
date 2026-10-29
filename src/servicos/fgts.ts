import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

/**
 * FGTS Digital: o aplicativo instalado entra no portal (login do usuário com o certificado do escritório), lê as
 * competências em aberto de cada cliente como procurador e manda o resultado para cá, onde fica o histórico.
 */

const Detalhe = z.object({
  tipo: z.string().max(40).nullish(), competencia: z.string().max(20).nullish(), vencimento: z.string().max(20).nullish(), pagamentoAte: z.string().max(20).nullish(),
  qtdTrabalhadores: z.number().nullish(), vlMensal: z.number().nullish(), vlRescisorio: z.number().nullish(), vlCompensatorio: z.number().nullish(), vlEncargos: z.number().nullish(),
  vlProcessoTrabalhista: z.number().nullish(), vlAtualizacaoMonetaria: z.number().nullish(), vlJuros: z.number().nullish(), vlMulta: z.number().nullish(), vlTotal: z.number().nullish(),
}).passthrough();
export const ResultadoFgts = z.object({
  empresa_id: z.number().int().positive(),
  situacao: z.enum(['EM_DIA', 'EM_ABERTO', 'SEM_PROCURACAO', 'ERRO']),
  total: z.number().nullish(),
  competencias: z.array(z.object({ id: z.string().max(10), competencia: z.string().max(20), total: z.number().nullish(), erro: z.string().max(500).nullish(), detalhes: z.array(Detalhe).max(50).nullish() })).max(120).nullish(),
  notificacao: z.boolean().nullish(),
  mensagem: z.string().max(500).nullish(),
});
export type ResultadoFgts = z.infer<typeof ResultadoFgts>;

export function salvarResultadosFgts(escritorioId: number, usuarioId: number | null, resultados: ResultadoFgts[]) {
  const ok = db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?');
  const ins = db.prepare('INSERT INTO fgts_consultas (empresa_id, situacao, total, qtd_competencias, competencias_json, notificacao, mensagem, usuario_id) VALUES (?,?,?,?,?,?,?,?)');
  let n = 0;
  db.transaction(() => {
    for (const r of resultados) {
      if (!ok.get(r.empresa_id, escritorioId)) continue;
      const comps = r.competencias ?? [];
      ins.run(r.empresa_id, r.situacao, r.total ?? (comps.length ? comps.reduce((t, c) => t + (c.total ?? 0), 0) : null), comps.length, comps.length ? JSON.stringify(comps) : null,
        r.notificacao == null ? null : r.notificacao ? 1 : 0, r.mensagem ?? null, usuarioId);
      n++;
    }
  })();
  return { gravados: n };
}

/** Última consulta ao FGTS de cada cliente (para o painel da Situação fiscal). */
export function ultimasFgts(escritorioId: number): Map<number, any> {
  const l = db.prepare(`SELECT f.empresa_id, f.id, f.situacao, f.total, f.qtd_competencias, f.notificacao, f.mensagem, f.consultado_em FROM fgts_consultas f JOIN empresas e ON e.id = f.empresa_id
    WHERE e.escritorio_id = ? AND f.id = (SELECT MAX(x.id) FROM fgts_consultas x WHERE x.empresa_id = f.empresa_id)`).all(escritorioId) as any[];
  return new Map(l.map((x) => [x.empresa_id, { ...x, notificacao: x.notificacao == null ? null : !!x.notificacao }]));
}

export function detalheFgts(escritorioId: number, empresaId: number) {
  const e = db.prepare('SELECT id, documento, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const h = db.prepare(`SELECT f.id, f.situacao, f.total, f.qtd_competencias, f.competencias_json, f.notificacao, f.mensagem, f.consultado_em, u.nome AS usuario
    FROM fgts_consultas f LEFT JOIN usuarios u ON u.id = f.usuario_id WHERE f.empresa_id = ? ORDER BY f.id DESC LIMIT 20`).all(empresaId) as any[];
  const [ultima, ...anteriores] = h.map(({ competencias_json, ...r }) => ({ ...r, notificacao: r.notificacao == null ? null : !!r.notificacao, competencias: competencias_json ? JSON.parse(competencias_json) : [] }));
  return { ...e, ultima: ultima ?? null, anteriores: anteriores.map(({ competencias, ...r }) => r) };
}
