import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-fgts-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('FGTS Digital: resultados gravados pelo aplicativo aparecem na situação fiscal', async () => {
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { regime: 'SIMPLES', cod_municipio: '4202404', uf: 'SC' };
    const a = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '43561105000122', razao_social: 'Bauer', tem_funcionarios: true }, t)).json.id;
    const b = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', tem_funcionarios: true }, t)).json.id;
    const det = { pagamentoAte: '2026-10-28', competencia: '06/2026', vencimento: '20/07/2026', qtdTrabalhadores: 1, vlMensal: 30.02, vlRescisorio: 0, vlJuros: 0, vlMulta: 0, vlTotal: 30.02 };
    const r = await call('POST', '/api/escritorio/fgts/resultados', { resultados: [
      { empresa_id: a, situacao: 'EM_ABERTO', total: 30.02, competencias: [{ id: '202606', competencia: '06/2026', total: 30.02, detalhes: [{ tipo: 'Mensal', ...det }] }], notificacao: false },
      { empresa_id: b, situacao: 'SEM_PROCURACAO', mensagem: 'Não existe procuração para o Número de Inscrição selecionado.' },
    ] }, t);
    assert.equal(r.status, 200); assert.equal(r.json.gravados, 2);
    const painel = (await call('GET', '/api/escritorio/situacao-fiscal', undefined, t)).json.clientes;
    const pa = painel.find((c: any) => c.empresa_id === a), pb = painel.find((c: any) => c.empresa_id === b);
    assert.deepEqual([pa.fgts.situacao, pa.fgts.total, pa.fgts.qtd_competencias, pa.tem_funcionarios], ['EM_ABERTO', 30.02, 1, true]);
    assert.equal(pb.fgts.situacao, 'SEM_PROCURACAO');
    const d = (await call('GET', `/api/escritorio/fgts/${a}`, undefined, t)).json;
    assert.equal(d.ultima.competencias[0].detalhes[0].vlMensal, 30.02);
    assert.equal((await call('POST', '/api/escritorio/fgts/resultados', { resultados: [{ empresa_id: a, situacao: 'QUALQUER' }] }, t)).status, 400);
    // nova consulta vira a última; a anterior fica no histórico
    await call('POST', '/api/escritorio/fgts/resultados', { resultados: [{ empresa_id: a, situacao: 'EM_DIA', competencias: [] }] }, t);
    const d2 = (await call('GET', `/api/escritorio/fgts/${a}`, undefined, t)).json;
    assert.equal(d2.ultima.situacao, 'EM_DIA'); assert.equal(d2.anteriores.length, 1);
  } finally { await app.close(); }
});
