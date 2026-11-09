import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-setup-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });

test('primeiro acesso: o CNPJ do escritório já deixa a empresa do escritório cadastrada', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/setup', payload: {
      escritorio: 'Ciclo Assessoria Contábil Ltda', nome: 'Ana', usuario: 'ana', email: 'ana@x.com', senha: 'senha-segura-1',
      empresa: { documento: '06990590000123', cod_municipio: '4202404', uf: 'SC', email: 'contato@ciclo.com.br', op_simp_nac: 3, cidade: 'Blumenau', cep: '89010000' },
    } });
    assert.equal(r.statusCode, 200); assert.equal(r.json().aviso, null);
    const e = db.prepare('SELECT documento, razao_social, regime, eh_escritorio, cod_municipio, na_carteira FROM empresas').all() as any[];
    assert.deepEqual(e.map((x) => ({ ...x })), [{ documento: '06990590000123', razao_social: 'Ciclo Assessoria Contábil Ltda', regime: 'SIMPLES', eh_escritorio: 1, cod_municipio: '4202404', na_carteira: 0 }]);
    // depois de configurado, a busca de CNPJ sem login fecha
    assert.equal((await app.inject({ method: 'GET', url: '/api/setup/cnpj/06990590000123' })).statusCode, 409);
  } finally { await app.close(); }
});

test('primeiro acesso sem os dados da Receita: cria o acesso e avisa para cadastrar a empresa depois', async () => {
  const { db } = await import('../src/db.js');
  db.prepare('DELETE FROM empresas').run(); db.prepare("DELETE FROM usuarios WHERE mestre = 0").run();
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { escritorio: 'Ciclo', nome: 'Ana', usuario: 'ana', email: 'ana@x.com', senha: 'senha-segura-1', empresa: { documento: '06990590000123' } } });
    assert.equal(r.statusCode, 200); assert.match(r.json().aviso, /Cadastros > Empresas/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM empresas').get() as any).n, 0);
  } finally { await app.close(); }
});
