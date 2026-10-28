import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-excluir-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('excluir empresa: só o master, com a senha master, apagando tudo o que é dela', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { garantirMaster, hashSenha } = await import('../src/auth.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    garantirMaster();
    db.prepare("UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE mestre = 1").run(hashSenha('senha-master-9'));
    const tm = (await call('POST', '/api/login', { usuario: 'kontor', senha: 'senha-master-9' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    const esc = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '06990590000123', razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t)).json.id;
    const alvo = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES', tem_funcionarios: true }, t)).json.id;
    await call('POST', `/api/empresas/${alvo}/tomadores`, { tipo_doc: 'CNPJ', documento: '11222333000181', nome: 'Cliente da Alfa' }, t);
    const { gerarTarefas } = await import('../src/servicos/obrigacoes.js');
    gerarTarefas?.(1, '2026-11');
    const tomNoEsc = (db.prepare('SELECT id FROM tomadores WHERE empresa_id = ? AND carteira_empresa_id = ?').get(esc, alvo) as any).id;

    assert.equal((await call('GET', `/api/empresas/${alvo}/exclusao`, undefined, t)).status, 403, 'administrador comum não exclui');
    assert.equal((await call('POST', `/api/empresas/${alvo}/excluir`, { senha: 'senha-segura-1' }, t)).status, 403);
    const res = (await call('GET', `/api/empresas/${alvo}/exclusao`, undefined, tm)).json;
    assert.equal(res.clientes, 1);
    assert.equal((await call('POST', `/api/empresas/${alvo}/excluir`, { senha: 'errada' }, tm)).status, 400);
    assert.ok(db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(alvo), 'senha errada não apaga');
    const r = await call('POST', `/api/empresas/${alvo}/excluir`, { senha: 'senha-master-9' }, tm);
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(r.json.copia), 'cópia de segurança antes de apagar');
    assert.equal(db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(alvo), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tomadores WHERE empresa_id = ?').get(alvo) as any).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tarefas WHERE empresa_id = ?').get(alvo) as any).n, 0);
    const tn = db.prepare('SELECT carteira_empresa_id FROM tomadores WHERE id = ?').get(tomNoEsc) as any;
    assert.equal(tn.carteira_empresa_id, null, 'o cliente na empresa do escritório fica, só desligado da carteira');
    assert.ok(db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(esc), 'as outras empresas continuam');
    // quem tem Certificados pode subir o A1 do cliente (a rota exige o arquivo)
    await call('POST', '/api/usuarios', { login: 'caio', nome: 'Caio', senha: 'senha-segura-4', tipo: 'normal', permissoes: ['certificados'] }, t);
    db.prepare("UPDATE usuarios SET trocar_senha = 0 WHERE login = 'CAIO'").run();
    const tc = (await call('POST', '/api/login', { usuario: 'caio', senha: 'senha-segura-4' })).json.token;
    const up = await app.inject({ method: 'POST', url: `/api/empresas/${esc}/certificado`, headers: { authorization: `Bearer ${tc}`, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x\r\nContent-Disposition: form-data; name="senha"\r\n\r\n123\r\n--x--\r\n' });
    assert.equal(up.statusCode, 400); assert.match(up.json().erro, /pfx/);
  } finally {
    await app.close();
  }
});
