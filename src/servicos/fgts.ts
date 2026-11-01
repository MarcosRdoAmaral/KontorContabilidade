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
  const l = db.prepare(`SELECT f.empresa_id, f.id, f.situacao, f.total, f.qtd_competencias, f.competencias_json, f.notificacao, f.mensagem, f.consultado_em FROM fgts_consultas f JOIN empresas e ON e.id = f.empresa_id
    WHERE e.escritorio_id = ? AND f.id = (SELECT MAX(x.id) FROM fgts_consultas x WHERE x.empresa_id = f.empresa_id)`).all(escritorioId) as any[];
  return new Map(l.map((x) => { const { competencias_json, competencias, ...r } = fgtsNaData(x)!; return [x.empresa_id, { ...r, notificacao: x.notificacao == null ? null : !!x.notificacao }]; }));
}

export function detalheFgts(escritorioId: number, empresaId: number) {
  const e = db.prepare('SELECT id, documento, COALESCE(nome_fantasia, razao_social) AS cliente FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!e) throw new ErroNegocio('Cliente não encontrado.', 404);
  const h = db.prepare(`SELECT f.id, f.situacao, f.total, f.qtd_competencias, f.competencias_json, f.notificacao, f.mensagem, f.consultado_em, u.nome AS usuario
    FROM fgts_consultas f LEFT JOIN usuarios u ON u.id = f.usuario_id WHERE f.empresa_id = ? ORDER BY f.id DESC LIMIT 20`).all(empresaId) as any[];
  const [ultima, ...anteriores] = h.map((x, i) => {
    const { competencias_json, ...r } = i === 0 ? fgtsNaData(x)! : { ...x, competencias: x.competencias_json ? JSON.parse(x.competencias_json) : [] };
    return { ...r, notificacao: r.notificacao == null ? null : !!r.notificacao };
  });
  return { ...e, ultima: ultima ?? null, anteriores: anteriores.map(({ competencias, ...r }) => r) };
}

// ---------------------------------------------------------------------------------------------
// Competência em aberto ≠ débito: a guia do mês corrente aparece "em aberto" no FGTS Digital antes de vencer.
// Só é valor em aberto (débito) o que já passou do vencimento; o resto é aviso de guia a vencer, como a DARF
// previdenciária da DCTFWeb.
// ---------------------------------------------------------------------------------------------
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
/** Data em ISO a partir de AAAA-MM-DD..., DD/MM/AAAA ou milissegundos; null se não der para ler. */
function dataIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
/** Competência (AAAA-MM, MM/AAAA ou AAAAMM) → AAAA-MM. */
function competenciaIso(v: unknown): string | null {
  const s = String(v ?? '');
  let m = /^(\d{4})-?(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{2})\/(\d{4})/.exec(s); if (m) return `${m[2]}-${m[1]}`;
  return null;
}
/** Vencimento da guia: o informado pelo FGTS Digital ou, sem ele, dia 20 do mês seguinte à competência. */
export function vencimentoFgts(c: any): string | null {
  const datas = (c?.detalhes ?? []).map((d: any) => dataIso(d.vencimento)).filter(Boolean) as string[];
  if (datas.length) return datas.sort()[0];
  const comp = competenciaIso(c?.competencia);
  if (!comp) return null;
  const [a, m] = comp.split('-').map(Number);
  return new Date(Date.UTC(a, m, 20)).toISOString().slice(0, 10);
}
/**
 * Consulta do FGTS vista na data de hoje: `total`/`qtd_competencias` passam a contar só as guias vencidas,
 * e as que ainda vão vencer ficam em `a_vencer`/`qtd_a_vencer` (situação A_VENCER quando só há essas).
 */
export function fgtsNaData<T extends Record<string, any>>(f: T | null | undefined, hoje = hojeBr()) {
  if (!f) return null;
  const comps: any[] = f.competencias ?? (f.competencias_json ? JSON.parse(f.competencias_json) : []);
  if (f.situacao !== 'EM_ABERTO' || !comps.length) return { ...f, a_vencer: 0, qtd_a_vencer: 0, proximo_vencimento: null as string | null, competencias: comps };
  const marcadas = comps.map((c) => { const v = vencimentoFgts(c); return { ...c, vencimento: v, a_vencer: !!v && v >= hoje }; });
  const vencidas = marcadas.filter((c) => !c.a_vencer), futuras = marcadas.filter((c) => c.a_vencer);
  const soma = (l: any[]) => Math.round(l.reduce((t, c) => t + (Number(c.total) || 0), 0) * 100) / 100;
  return {
    ...f, competencias: marcadas,
    situacao: vencidas.length ? 'EM_ABERTO' : 'A_VENCER',
    total: soma(vencidas), qtd_competencias: vencidas.length,
    a_vencer: soma(futuras), qtd_a_vencer: futuras.length,
    proximo_vencimento: futuras.map((c) => c.vencimento).sort()[0] ?? null,
  };
}
