import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { ErroNegocio } from './emissao.js';

/**
 * Exclusão definitiva de uma empresa (só o usuário master, com a senha dele).
 * Apaga a empresa e tudo o que é dela, seguindo as chaves estrangeiras do banco: notas, cobranças, clientes
 * (tomadores), serviços, compras, despesas, extratos, obrigações, contratos etc. Antes, faz uma cópia de segurança
 * do banco inteiro em "antes-de-excluir", para desfazer se preciso.
 */

/** Referências diretas à empresa que só são desligadas (a linha pertence a outra empresa). */
const SO_DESLIGAR = new Set(['tomadores.carteira_empresa_id', 'empresas.id']);

type Ref = { tabela: string; coluna: string; obrigatoria: boolean; cascata: boolean };
let mapa: Map<string, Ref[]> | null = null;
function referencias(alvo: string): Ref[] {
  if (!mapa) {
    mapa = new Map();
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number }[];
      for (const f of db.prepare(`PRAGMA foreign_key_list(${name})`).all() as { table: string; from: string; on_delete: string }[]) {
        const l = mapa.get(f.table) ?? [];
        l.push({ tabela: name, coluna: f.from, obrigatoria: !!cols.find((c) => c.name === f.from)?.notnull, cascata: f.on_delete === 'CASCADE' });
        mapa.set(f.table, l);
      }
    }
  }
  return mapa.get(alvo) ?? [];
}

/** Apaga as linhas de `tabela` que atendem `onde`, e antes tudo o que depende delas. */
function apagar(tabela: string, onde: string, params: unknown[]) {
  const ids = `SELECT id FROM ${tabela} WHERE ${onde}`;
  for (const r of referencias(tabela)) {
    const dona = tabela === 'empresas' ? !SO_DESLIGAR.has(`${r.tabela}.${r.coluna}`) : r.obrigatoria || r.cascata;
    if (dona) apagar(r.tabela, `${r.coluna} IN (${ids})`, params);
    else db.prepare(`UPDATE ${r.tabela} SET ${r.coluna} = NULL WHERE ${r.coluna} IN (${ids})`).run(...params);
  }
  db.prepare(`DELETE FROM ${tabela} WHERE ${onde}`).run(...params);
}

function empresaDoEscritorio(escritorioId: number, id: number) {
  const e = db.prepare('SELECT id, razao_social, documento, eh_escritorio FROM empresas WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!e) throw new ErroNegocio('Empresa não encontrada.', 404);
  return e;
}

/** O que será apagado junto, para a tela de confirmação. */
export function resumoExclusao(escritorioId: number, id: number) {
  const e = empresaDoEscritorio(escritorioId, id);
  const n = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
  return {
    empresa: { id: e.id, razao_social: e.razao_social, documento: e.documento, eh_escritorio: !!e.eh_escritorio },
    notas: n('SELECT COUNT(*) AS n FROM notas WHERE empresa_id = ?'),
    cobrancas: n('SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id = ?'),
    clientes: n('SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id = ?'),
    compras: n('SELECT COUNT(*) AS n FROM compras WHERE empresa_id = ?') + n('SELECT COUNT(*) AS n FROM nfe_recebidas WHERE empresa_id = ?'),
    despesas: n('SELECT COUNT(*) AS n FROM despesas WHERE empresa_id = ?'),
    tarefas: n('SELECT COUNT(*) AS n FROM tarefas WHERE empresa_id = ?'),
    contratos: n('SELECT COUNT(*) AS n FROM contratos WHERE empresa_id = ?'),
  };
}

export function excluirEmpresa(escritorioId: number, id: number) {
  const e = empresaDoEscritorio(escritorioId, id);
  // cópia de segurança do banco antes de apagar
  const pasta = path.join(path.dirname(config.databasePath), 'antes-de-excluir');
  fs.mkdirSync(pasta, { recursive: true });
  const copia = path.join(pasta, `antes-de-excluir-${e.documento}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
  db.copiarPara(copia);
  db.transaction(() => {
    db.prepare('UPDATE usuarios SET ultima_empresa_id = NULL WHERE ultima_empresa_id = ?').run(id);
    apagar('empresas', 'id = ?', [id]);
  })();
  return { ok: true, copia };
}
