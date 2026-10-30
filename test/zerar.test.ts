import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-zerar-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('zerar dados: só o master, com senha e ZERAR; mantém usuários, escritório e configuração', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { garantirMaster, hashSenha } = await import('../src/auth.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  const conta = (sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as any).n;
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    garantirMaster();
    db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE mestre = 1').run(hashSenha('senha-master-9'));
    const tm = (await call('POST', '/api/login', { usuario: 'kontor', senha: 'senha-master-9' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    const esc = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '06990590000123', razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t)).json.id;
    const alfa = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES', tem_funcionarios: true }, t)).json.id;
    await call('POST', '/api/escritorio/carteira', { ...base, documento: '11222333000181', razao_social: 'Beta', regime: 'PRESUMIDO' }, t);
    await call('POST', `/api/empresas/${esc}/tomadores`, { tipo_doc: 'CNPJ', documento: '60746948000112', nome: 'Avulso' }, t);
    const { gerarTarefas } = await import('../src/servicos/obrigacoes.js');
    gerarTarefas?.(1, '2026-11');
    assert.ok(conta('SELECT COUNT(*) AS n FROM tarefas WHERE empresa_id = ?', alfa) > 0);
    const tomCarteira = conta('SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id = ? AND carteira_empresa_id IS NOT NULL', esc);
    assert.ok(tomCarteira >= 2, 'clientes da carteira têm o tomador no escritório (cadastro único)');

    assert.equal((await call('GET', '/api/zerar', undefined, t)).status, 403, 'administrador comum não zera');
    assert.equal((await call('POST', '/api/zerar', { senha: 'senha-segura-1', confirmacao: 'ZERAR', clientes: true, movimento: true }, t)).status, 403);
    const r0 = (await call('GET', '/api/zerar', undefined, tm)).json;
    assert.equal(r0.clientes.carteira, 2);
    assert.equal(r0.movimento.tomadores, 1, 'só o tomador avulso conta como movimento');
    assert.equal((await call('POST', '/api/zerar', { senha: 'errada', confirmacao: 'ZERAR', clientes: true, movimento: true }, tm)).status, 400);
    assert.equal((await call('POST', '/api/zerar', { senha: 'senha-master-9', confirmacao: 'sim', clientes: true, movimento: true }, tm)).status, 400);
    assert.equal((await call('POST', '/api/zerar', { senha: 'senha-master-9', confirmacao: 'ZERAR', clientes: false, movimento: false }, tm)).status, 400);
    assert.equal(conta('SELECT COUNT(*) AS n FROM empresas'), 3, 'nada apagado ainda');

    // só o movimento: clientes ficam, com o tomador do cadastro único
    let r = await call('POST', '/api/zerar', { senha: 'senha-master-9', confirmacao: 'zerar', clientes: false, movimento: true }, tm);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(fs.existsSync(r.json.copia));
    assert.equal(conta('SELECT COUNT(*) AS n FROM empresas'), 3);
    assert.equal(conta('SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id = ?', esc), tomCarteira, 'avulso apagado, os da carteira ficam');
    assert.ok(conta('SELECT COUNT(*) AS n FROM tarefas WHERE empresa_id = ?', alfa) > 0, 'agenda dos clientes fica');

    // tudo
    r = await call('POST', '/api/zerar', { senha: 'senha-master-9', confirmacao: 'ZERAR', clientes: true, movimento: true }, tm);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(conta('SELECT COUNT(*) AS n FROM empresas'), 1);
    assert.ok(db.prepare('SELECT 1 FROM empresas WHERE id = ? AND eh_escritorio = 1').get(esc), 'a empresa do escritório fica');
    assert.equal(conta('SELECT COUNT(*) AS n FROM tomadores'), 0);
    assert.equal(conta('SELECT COUNT(*) AS n FROM tarefas'), 0);
    assert.equal(conta('SELECT COUNT(*) AS n FROM usuarios'), 2, 'usuários ficam');
    assert.equal((await call('POST', '/api/login', { usuario: 'ana', senha: 'senha-segura-1' })).status, 200, 'e continuam entrando');
  } finally {
    await app.close();
  }
});
