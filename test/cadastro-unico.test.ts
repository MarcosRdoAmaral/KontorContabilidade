import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-cadastro-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

const ESC = '06990590000123', PADARIA = '11222333000181', ALFA = '45723174000110', CPF = '39053344705';

test('cadastro único: carteira e Clientes do escritório são o mesmo cliente', async () => {
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
    // cliente da carteira criado antes de existir a empresa do escritório: liga quando o escritório é marcado
    const alfa = (await call('POST', '/api/escritorio/carteira', { ...base, documento: ALFA, razao_social: 'Alfa Ltda', regime: 'SIMPLES', email: 'alfa@x.com' }, t)).json.id;
    const esc = (await call('POST', '/api/escritorio/carteira', { ...base, documento: ESC, razao_social: 'Ciclo Assessoria', regime: 'SIMPLES', eh_escritorio: true }, t)).json.id;
    const tomadores = () => db.prepare('SELECT * FROM tomadores WHERE empresa_id = ? ORDER BY id').all(esc) as any[];
    assert.equal(tomadores().length, 1);
    assert.deepEqual([tomadores()[0].carteira_empresa_id, tomadores()[0].nome, tomadores()[0].email, tomadores()[0].tipo_doc], [alfa, 'Alfa Ltda', 'alfa@x.com', 'CNPJ']);

    // cliente que já existia em Clientes (com endereço) e entra na carteira sem endereço: não duplica e a carteira herda o endereço
    const tomPadaria = (await call('POST', `/api/empresas/${esc}/tomadores`, { tipo_doc: 'CNPJ', documento: PADARIA, nome: 'Padaria (antigo)', email: 'pao@x.com', fone: '48999990000',
      cep: '89010000', cod_municipio: '4202404', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Blumenau', uf: 'SC', modo_faturamento: 'NOTA_BOLETO', vencimento_tipo: 'DIA_FIXO', vencimento_valor: 10 }, t)).json.id;
    const padaria = (await call('POST', '/api/escritorio/carteira', { ...base, documento: PADARIA, razao_social: 'Padaria Boa Ltda', regime: 'SIMPLES' }, t)).json.id;
    assert.equal(tomadores().length, 2, 'não criou outro cliente');
    const tp = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomPadaria) as any;
    assert.deepEqual([tp.carteira_empresa_id, tp.nome, tp.logradouro, tp.modo_faturamento], [padaria, 'Padaria Boa Ltda', 'Rua A', 'NOTA_BOLETO']);
    const ep = db.prepare('SELECT * FROM empresas WHERE id = ?').get(padaria) as any;
    assert.deepEqual([ep.email, ep.contato_fone, ep.logradouro, ep.bairro, ep.cep], ['pao@x.com', '48999990000', 'Rua A', 'Centro', '89010000'], 'a carteira herdou o que só Clientes tinha');

    // editar na carteira atualiza Clientes
    const cart = (await call('GET', '/api/escritorio/carteira', undefined, t)).json.find((c: any) => c.id === padaria);
    assert.equal((await call('PUT', `/api/escritorio/carteira/${padaria}`, { ...base, documento: PADARIA, razao_social: 'Padaria Nova Ltda', regime: 'SIMPLES', email: 'novo@x.com',
      cep: cart.cep, logradouro: 'Rua B', numero: '20', bairro: 'Centro', cidade: 'Blumenau', contato_fone: '48999990000' }, t)).status, 200);
    let tp2 = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomPadaria) as any;
    assert.deepEqual([tp2.nome, tp2.email, tp2.logradouro, tp2.numero], ['Padaria Nova Ltda', 'novo@x.com', 'Rua B', '20']);

    // em Clientes, o que vem da carteira não muda; o faturamento muda
    assert.equal((await call('PUT', `/api/tomadores/${tomPadaria}`, { tipo_doc: 'CNPJ', documento: PADARIA, nome: 'Outro nome', email: 'x@x.com', modo_faturamento: 'NOTA', vencimento_tipo: 'PRAZO', vencimento_valor: 5 }, t)).status, 200);
    tp2 = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomPadaria) as any;
    assert.deepEqual([tp2.nome, tp2.email, tp2.logradouro, tp2.modo_faturamento, tp2.vencimento_valor], ['Padaria Nova Ltda', 'novo@x.com', 'Rua B', 'NOTA', 5]);
    // cadastrar de novo em Clientes um cliente da carteira é recusado
    assert.equal((await call('POST', `/api/empresas/${esc}/tomadores`, { tipo_doc: 'CNPJ', documento: ALFA, nome: 'Alfa' }, t)).status, 409);

    // cliente avulso (só em Clientes) pode ser trazido para a carteira
    const tomCpf = (await call('POST', `/api/empresas/${esc}/tomadores`, { tipo_doc: 'CPF', documento: CPF, nome: 'Fulano de Tal', cod_municipio: '4202404', cidade: 'Blumenau', uf: 'SC' }, t)).json.id;
    const semMun = (await call('POST', `/api/empresas/${esc}/tomadores`, { tipo_doc: 'CNPJ', documento: '27865757000102', nome: 'Sem Município' }, t)).json.id;
    const fora = (await call('GET', '/api/escritorio/carteira/fora', undefined, t)).json;
    assert.deepEqual(fora.map((x: any) => x.id).sort(), [tomCpf, semMun].sort());
    const tr = (await call('POST', '/api/escritorio/carteira/trazer', { itens: [{ tomador_id: tomCpf, regime: 'PF' }, { tomador_id: semMun, regime: 'SIMPLES' }] }, t)).json;
    assert.equal(tr.resultados.find((r: any) => r.tomador_id === tomCpf).ok, true);
    assert.match(tr.resultados.find((r: any) => r.tomador_id === semMun).mensagem, /Município/);
    const tc = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomCpf) as any;
    assert.ok(tc.carteira_empresa_id, 'o mesmo cadastro, agora ligado');
    assert.equal((db.prepare('SELECT regime FROM empresas WHERE id = ?').get(tc.carteira_empresa_id) as any).regime, 'PF');
    assert.equal(tomadores().length, 4, 'nenhum cliente duplicado');
    assert.deepEqual((await call('GET', '/api/escritorio/carteira/fora', undefined, t)).json.map((x: any) => x.id), [semMun]);

    // sincronizar de novo não muda nada (roda ao abrir o sistema)
    const { sincronizarTodosOsEscritorios } = await import('../src/servicos/cadastro-unico.js');
    sincronizarTodosOsEscritorios(); sincronizarTodosOsEscritorios();
    assert.equal(tomadores().length, 4);
  } finally {
    await app.close();
  }
});
