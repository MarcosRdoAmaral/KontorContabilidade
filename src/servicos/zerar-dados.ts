import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { ErroNegocio } from './emissao.js';
import { apagar } from './excluir-empresa.js';

/**
 * "Zerar dados" (Configurações > Backup, só o usuário master): limpa a base para recomeçar sem reinstalar.
 * Sempre ficam: usuários, licença, configurações (e-mail, Integra Contador, avisos), a empresa do escritório com o
 * certificado, a numeração das notas (DPS), os serviços, as contas bancárias, as categorias e regras, os modelos de
 * contrato e o catálogo de obrigações. Antes de apagar, guarda uma cópia do banco em "antes-de-zerar".
 */

export const EscopoZerar = z.object({
  /** Todos os clientes da carteira e as outras empresas cadastradas, com tudo o que é deles. */
  clientes: z.boolean(),
  /** Movimento da empresa do escritório: notas, boletos, tomadores avulsos, compras, despesas, extratos, cartões, estoque. */
  movimento: z.boolean(),
}).refine((e) => e.clientes || e.movimento, 'Escolha o que zerar.');

/** Tabelas da empresa do escritório que são configuração, não movimento (ficam). As de distribuição guardam o
 * ponto (NSU) em que a captura parou: zerá-las faria o sistema baixar de novo o que acabou de ser apagado. */
const MANTER = new Set(['usuario_empresas', 'sequencias_dps', 'servicos', 'tipos_documento', 'perfis_tributacao', 'documento_tributos', 'contas_bancarias',
  'despesa_categorias', 'extrato_regras', 'certificados', 'empresa_obrigacoes', 'nfe_distribuicao', 'adn_distribuicao']);

/** Tabelas com coluna empresa_id ligada a empresas (as que guardam algo de uma empresa). */
function tabelasDaEmpresa() {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((t) => t.name)
    .filter((t) => (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string; from: string }[]).some((f) => f.table === 'empresas' && f.from === 'empresa_id'));
}

const idsEscritorio = (escritorioId: number) => (db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').all(escritorioId) as { id: number }[]).map((e) => e.id);
const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

/** Quantidades que seriam apagadas, para a tela de confirmação. */
export function resumoZerar(escritorioId: number) {
  const esc = idsEscritorio(escritorioId);
  const em = esc.length ? esc.join(',') : 'NULL';
  return {
    escritorio: db.prepare('SELECT razao_social, documento FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1 ORDER BY id LIMIT 1').get(escritorioId) ?? null,
    clientes: {
      carteira: n('SELECT COUNT(*) AS n FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 0 AND na_carteira = 1', escritorioId),
      empresas: n('SELECT COUNT(*) AS n FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 0 AND na_carteira = 0', escritorioId),
    },
    movimento: {
      notas: n(`SELECT COUNT(*) AS n FROM notas WHERE empresa_id IN (${em})`),
      cobrancas: n(`SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id IN (${em})`),
      tomadores: n(`SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id IN (${em}) AND carteira_empresa_id IS NULL`),
      compras: n(`SELECT COUNT(*) AS n FROM compras WHERE empresa_id IN (${em})`) + n(`SELECT COUNT(*) AS n FROM nfe_recebidas WHERE empresa_id IN (${em})`),
      despesas: n(`SELECT COUNT(*) AS n FROM despesas WHERE empresa_id IN (${em})`),
    },
  };
}

export function zerarDados(escritorioId: number, escopo: z.infer<typeof EscopoZerar>) {
  const esc = idsEscritorio(escritorioId);
  if (!esc.length && escopo.clientes) throw new ErroNegocio('A empresa do escritório não está cadastrada; para zerar tudo, apague a pasta de dados com o sistema fechado.', 400);
  const pasta = path.join(path.dirname(config.databasePath), 'antes-de-zerar');
  fs.mkdirSync(pasta, { recursive: true });
  const copia = path.join(pasta, `antes-de-zerar-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
  db.copiarPara(copia);
  const antes = resumoZerar(escritorioId);
  db.transaction(() => {
    if (escopo.clientes) {
      db.prepare(`UPDATE usuarios SET ultima_empresa_id = NULL WHERE ultima_empresa_id IN (SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 0)`).run(escritorioId);
      apagar('empresas', 'escritorio_id = ? AND eh_escritorio = 0', [escritorioId]);
    }
    if (escopo.movimento && esc.length) {
      const em = esc.join(',');
      // tomador ligado a um cliente da carteira é o próprio cliente (cadastro único): fica enquanto o cliente existir
      for (const t of tabelasDaEmpresa()) if (!MANTER.has(t)) apagar(t, `empresa_id IN (${em})${t === 'tomadores' ? ' AND carteira_empresa_id IS NULL' : ''}`, []);
      db.prepare('DELETE FROM nfe_saidas WHERE escritorio_id = ?').run(escritorioId);
      db.prepare('DELETE FROM log_comunicacao WHERE nota_id IS NULL').run();
    }
  })();
  return { ok: true, copia, apagado: { clientes: escopo.clientes ? antes.clientes : null, movimento: escopo.movimento ? antes.movimento : null } };
}
