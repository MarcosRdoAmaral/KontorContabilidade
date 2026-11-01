import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('FGTS: guia a vencer não é débito; Monitor olha a competência em processamento', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-mc-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x' });
  const { fgtsNaData, vencimentoFgts } = await import('../src/servicos/fgts.js');
  const { competenciaEmProcessamento, fimDaCompetencia, prazoComControle } = await import('../src/servicos/monitor.js');

  // vencimento: o do portal ou dia 20 do mês seguinte
  assert.equal(vencimentoFgts({ competencia: '2026-10' }), '2026-11-20');
  assert.equal(vencimentoFgts({ competencia: '10/2026' }), '2026-11-20');
  assert.equal(vencimentoFgts({ competencia: '2026-10', detalhes: [{ vencimento: '19/11/2026' }] }), '2026-11-19');
  const f = { situacao: 'EM_ABERTO', total: 779.34, qtd_competencias: 4, competencias_json: JSON.stringify([
    { competencia: '2026-07', total: 200 }, { competencia: '2026-08', total: 200 }, { competencia: '2026-09', total: 179.34 }, { competencia: '2026-10', total: 200 }]) };
  const x = fgtsNaData(f, '2026-11-01')!;
  assert.deepEqual([x.situacao, x.total, x.qtd_competencias, x.a_vencer, x.qtd_a_vencer, x.proximo_vencimento], ['EM_ABERTO', 579.34, 3, 200, 1, '2026-11-20']);
  const so = fgtsNaData({ situacao: 'EM_ABERTO', total: 200, competencias_json: JSON.stringify([{ competencia: '2026-10', total: 200 }]) }, '2026-11-01')!;
  assert.deepEqual([so.situacao, so.total, so.a_vencer], ['A_VENCER', 0, 200], 'só a guia do mês: aviso, sem valor em aberto');
  assert.equal(fgtsNaData({ situacao: 'EM_ABERTO', competencias_json: JSON.stringify([{ competencia: '2026-10', total: 200 }]) }, '2026-11-21')!.situacao, 'EM_ABERTO', 'depois do vencimento vira débito');

  // competência
  assert.equal(competenciaEmProcessamento('2026-11-01'), '2026-10');
  assert.equal(competenciaEmProcessamento('2026-01-15'), '2025-12');
  assert.deepEqual(['2026-10', '2026-T3', '2026-T4', '2025', '2026'].map(fimDaCompetencia), ['2026-10', '2026-09', '2026-12', '2025-12', '2026-12']);
  // feito no Controle mensal conta como entregue
  const t = { empresa_id: 7, codigo: 'DAS', competencia: '2026-10', status: 'PENDENTE', vencimento: '2026-11-20', antecedencia: 5 };
  assert.equal(prazoComControle(t, new Set(['7:2026-10:FISCAL']), '2026-11-01'), 'ENTREGUE');
  assert.notEqual(prazoComControle(t, new Set(['7:2026-10:DP']), '2026-11-01'), 'ENTREGUE');
});
