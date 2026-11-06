import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-monitor-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });
process.env.LICENCA_CHAVE_PUBLICA ??= '';

test('monitor fiscal: ignorar uma coluna em um cliente tira da tela, do status geral e dos avisos', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    const a = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES', tem_funcionarios: true }, t)).json.id;
    const b = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '11222333000181', razao_social: 'Beta', regime: 'PRESUMIDO' }, t)).json.id;
    db.prepare("INSERT INTO fgts_consultas (empresa_id, situacao, total, qtd_competencias) VALUES (?, 'EM_ABERTO', 500, 1)").run(a);
    db.prepare("INSERT INTO fgts_consultas (empresa_id, situacao, mensagem) VALUES (?, 'SEM_PROCURACAO', 'sem procuração')").run(b);
    const ler = async () => (await call('GET', '/api/escritorio/monitor', undefined, t)).json;

    let m = await ler();
    const cli = (id: number) => m.clientes.find((c: any) => c.empresa_id === id);
    assert.equal(cli(a).processos.FGTS, 'ATENCAO');
    assert.equal(cli(b).processos.FGTS, 'PENDENTE');
    assert.ok(m.notificacoes.some((n: any) => n.processo === 'FGTS' && n.empresa_id === b));
    assert.deepEqual(cli(b).ignorados, []);

    // ignora o FGTS Digital só do cliente Beta
    assert.equal((await call('PUT', `/api/escritorio/monitor/${b}/ignorar`, { processo: 'FGTS', ignorar: true }, t)).status, 200);
    m = await ler();
    assert.equal(cli(b).processos.FGTS, null);
    assert.deepEqual(cli(b).ignorados, ['FGTS']);
    assert.notEqual(cli(b).geral, 'PENDENTE', 'o status geral deixa de contar a coluna ignorada');
    assert.ok(!m.notificacoes.some((n: any) => n.processo === 'FGTS' && n.empresa_id === b), 'sem avisos do que foi ignorado');
    assert.equal(cli(a).processos.FGTS, 'ATENCAO', 'os outros clientes não mudam');
    assert.ok(m.notificacoes.some((n: any) => n.processo === 'FGTS' && n.empresa_id === a));

    // volta a acompanhar
    await call('PUT', `/api/escritorio/monitor/${b}/ignorar`, { processo: 'FGTS', ignorar: false }, t);
    m = await ler();
    assert.equal(cli(b).processos.FGTS, 'PENDENTE');

    // só o administrador ignora (usuário normal com acesso ao Monitor recebe 403)
    const novoJoao = await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['visao', 'situacao'], empresas: [] }, t);
    assert.equal(novoJoao.status, 200);
    const l1 = (await call('POST', '/api/login', { usuario: 'JOAO', senha: novoJoao.json.senhaProvisoria })).json;
    await call('PUT', '/api/me/senha', { atual: novoJoao.json.senhaProvisoria, nova: 'joao-nova-123' }, l1.token);
    const tj = (await call('POST', '/api/login', { usuario: 'JOAO', senha: 'joao-nova-123' })).json.token;
    assert.equal((await call('GET', '/api/escritorio/monitor', undefined, tj)).status, 200);
    assert.equal((await call('PUT', `/api/escritorio/monitor/${b}/ignorar`, { processo: 'FGTS', ignorar: true }, tj)).status, 403);
    // coluna inexistente e cliente de outro escritório são recusados
    assert.equal((await call('PUT', `/api/escritorio/monitor/${b}/ignorar`, { processo: 'XYZ', ignorar: true }, t)).status, 400);
    assert.equal((await call('PUT', `/api/escritorio/monitor/99999/ignorar`, { processo: 'FGTS', ignorar: true }, t)).status, 404);
  } finally { await app.close(); }
});
