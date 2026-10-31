import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-monitor-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('monitor fiscal e resumo financeiro pelos XML', async () => {
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
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), mes = hoje.slice(0, 7);
    const mesAnt = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)) - 2, 1)).toISOString().slice(0, 7);
    db.prepare("INSERT INTO fgts_consultas (empresa_id, situacao, total, qtd_competencias) VALUES (?, 'EM_ABERTO', 500, 1)").run(a);
    db.prepare("INSERT INTO situacao_fiscal (empresa_id, status, situacao) VALUES (?, 'PRONTA', 'REGULAR')").run(b);
    db.prepare("INSERT INTO certificados (escritorio_id, empresa_id, tipo, titular, validade) VALUES (1, ?, 'PROCURACAO', 'B', '2000-01-01')").run(b);

    const m = (await call('GET', '/api/escritorio/monitor', undefined, t)).json;
    assert.equal(m.total, 2);
    const ca = m.clientes.find((c: any) => c.empresa_id === a), cb = m.clientes.find((c: any) => c.empresa_id === b);
    assert.equal(ca.processos.FGTS, 'ATENCAO');
    assert.equal(ca.geral, 'ATENCAO');
    assert.equal(cb.processos.SITFIS, 'EM_DIA');
    assert.equal(cb.processos.CERT, 'ATENCAO', 'procuração vencida');
    assert.equal(cb.processos.FGTS, null, 'nunca consultado = sem informação');
    assert.equal(m.geral.ATENCAO, 2);
    assert.ok(m.notificacoes.some((n: any) => n.processo === 'FGTS' && n.empresa_id === a));
    assert.equal(m.processos.find((p: any) => p.id === 'FGTS').contagem.SEM_DADOS, 1);

    // notas capturadas da Alfa: venda, remessa (fora), compra, compra cancelada, NFS-e prestada e tomada
    const ch = (n: number) => String(n).padStart(44, '0');
    db.prepare("INSERT INTO nfe_saidas (escritorio_id, chave, emitente_documento, natureza, emissao, valor, situacao, xml) VALUES (1,?,?,?,?,?,'AUTORIZADA','<x/>')").run(ch(1), '45723174000110', 'Venda de mercadoria', `${mes}-02T10:00:00-03:00`, 1000);
    db.prepare("INSERT INTO nfe_saidas (escritorio_id, chave, emitente_documento, natureza, emissao, valor, situacao, xml) VALUES (1,?,?,?,?,?,'AUTORIZADA','<x/>')").run(ch(2), '45723174000110', 'Remessa para conserto', `${mes}-03T10:00:00-03:00`, 999);
    db.prepare("INSERT INTO nfe_recebidas (empresa_id, chave, emissao, valor, situacao, xml) VALUES (?,?,?,?,?,?)").run(a, ch(3), `${mes}-04T10:00:00-03:00`, 400, 'AUTORIZADA', '<natOp>Venda</natOp>');
    db.prepare("INSERT INTO nfe_recebidas (empresa_id, chave, emissao, valor, situacao, xml) VALUES (?,?,?,?,?,?)").run(a, ch(4), `${mes}-05T10:00:00-03:00`, 300, 'CANCELADA', '<natOp>Venda</natOp>');
    db.prepare("INSERT INTO nfse_capturadas (empresa_id, chave, papel, competencia, valor, situacao, xml) VALUES (?,?,?,?,?,'AUTORIZADA','<x/>')").run(a, 'S1', 'PRESTADOR', `${mes}-01`, 500);
    db.prepare("INSERT INTO nfse_capturadas (empresa_id, chave, papel, competencia, valor, situacao, xml) VALUES (?,?,?,?,?,'AUTORIZADA','<x/>')").run(a, 'S2', 'TOMADOR', `${mes}-01`, 100);
    db.prepare("INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json) VALUES (?, ?, 'FISCAL', ?)").run(a, mesAnt, JSON.stringify({ faturamento: 50000 }));

    const r = (await call('GET', `/api/escritorio/resumo-financeiro/${a}?mes=${mes}`, undefined, t)).json;
    assert.equal(r.kpis.receita, 1500);
    assert.equal(r.kpis.custo, 500);
    assert.equal(r.kpis.lucro, 1000);
    assert.equal(r.kpis.fora, 1, 'remessa fora da receita');
    assert.equal(r.kpis.xmls, 6);
    assert.equal(r.serie.length, 12);
    // faturamento acumulado pelas declarações do PGDAS-D guardadas
    const ano = mes.slice(0, 4);
    db.prepare("INSERT INTO pgdas_receitas (empresa_id, competencia, rpa, rbt12, rba) VALUES (?, ?, 400000, 3500000, 2700000)").run(a, `${ano}-09`);
    let m2 = (await call('GET', '/api/escritorio/monitor', undefined, t)).json;
    let sl = m2.sublimites.clientes.find((x: any) => x.empresa_id === a);
    assert.equal(sl.acumulado, 3100000);
    assert.equal(sl.situacao, 'PENDENTE', '86% do sublimite');
    assert.ok(m2.notificacoes.some((n: any) => n.titulo.includes('sublimite') && n.empresa_id === a));
    db.prepare("UPDATE pgdas_receitas SET rba = 3400000 WHERE empresa_id = ?").run(a);
    sl = (await call('GET', '/api/escritorio/monitor', undefined, t)).json.sublimites.clientes.find((x: any) => x.empresa_id === a);
    assert.equal(sl.situacao, 'ATENCAO'); assert.match(sl.motivo, /janeiro/);
    db.prepare("UPDATE pgdas_receitas SET rba = 900000, rpa = 100000 WHERE empresa_id = ?").run(a);
    sl = (await call('GET', '/api/escritorio/monitor', undefined, t)).json.sublimites.clientes.find((x: any) => x.empresa_id === a);
    assert.equal(sl.situacao, 'EM_DIA'); assert.equal(sl.projecao, 1333333.33);

    await call('POST', '/api/usuarios', { login: 'caio', nome: 'Caio', senha: 'senha-segura-4', tipo: 'normal', permissoes: ['carteira'] }, t);
    db.prepare("UPDATE usuarios SET trocar_senha = 0 WHERE login = 'CAIO'").run();
    const tc = (await call('POST', '/api/login', { usuario: 'caio', senha: 'senha-segura-4' })).json.token;
    assert.equal((await call('GET', '/api/escritorio/monitor', undefined, tc)).status, 403);
    // tela de início: lembretes só do que cada um pode ver
    const li = (await call('GET', '/api/inicio', undefined, t)).json.lembretes;
    assert.ok(li.some((l: any) => /certificado/.test(l.texto)), 'administrador vê o certificado vencido');
    assert.deepEqual((await call('GET', '/api/inicio', undefined, tc)).json.lembretes, [], 'só Carteira: nenhum lembrete');
    assert.equal((await call('GET', `/api/escritorio/resumo-financeiro/${a}?mes=${mes}`, undefined, tc)).status, 403);
  } finally {
    await app.close();
  }
});
