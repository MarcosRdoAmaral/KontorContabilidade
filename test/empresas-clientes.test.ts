import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-empcli-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('empresas do sistema separadas dos clientes; planilha na carteira; inativar', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const emp = { razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3 };
    const esc = (await call('POST', '/api/empresas', { ...emp, documento: '06990590000123', eh_escritorio: true, crc: 'SC-1', cidade: 'Blumenau' }, t)).json.id;
    const cli = (await call('POST', '/api/escritorio/carteira', { documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES', cod_municipio: '4202404' }, t)).json.id;
    assert.deepEqual((await call('GET', '/api/empresas', undefined, t)).json.map((e: any) => e.id), [esc], 'cliente não aparece em Empresas');
    assert.deepEqual((await call('GET', '/api/escritorio/carteira', undefined, t)).json.map((e: any) => e.id), [cli], 'empresa não aparece na Carteira');
    assert.equal((await call('GET', '/api/empresas?todas=1', undefined, t)).json.length, 2);
    // empresa do sistema não entra na carteira por engano; cliente pode passar a ser também empresa
    assert.equal((await call('POST', '/api/escritorio/carteira', { documento: '06990590000123', razao_social: 'Outro nome', regime: 'SIMPLES', cod_municipio: '4202404' }, t)).status, 409);
    const conv = (await call('POST', '/api/empresas', { ...emp, razao_social: 'Alfa', documento: '45723174000110' }, t)).json.id;
    assert.equal(conv, cli, 'sem duplicar');
    const ec = db.prepare('SELECT gerencia, na_carteira FROM empresas WHERE id = ?').get(cli) as any;
    assert.deepEqual([ec.gerencia, ec.na_carteira], [1, 1]);

    // inativar (não apaga)
    assert.equal((await call('POST', `/api/empresas/${cli}/ativo`, { ativo: false }, t)).status, 200);
    assert.equal((db.prepare('SELECT ativo FROM empresas WHERE id = ?').get(cli) as any).ativo, 0);

    // planilha na carteira
    const csv = Buffer.from('CNPJ;Nome\n11.222.333/0001-81;Padaria\n45723174000110;Alfa\n39053344705;Fulano de Tal\n').toString('base64');
    const an = (await call('POST', '/api/escritorio/carteira/planilha/analisar', { nome: 'c.csv', base64: csv }, t)).json;
    assert.deepEqual([an.resumo.novos, an.resumo.existentes], [2, 1]);
    const { importarParaCarteira } = await import('../src/servicos/importar-clientes.js');
    const buscar = async (d: string) => ({ documento: d, razao_social: 'PADARIA BOA LTDA', nome_fantasia: 'Padaria', situacao: 'ATIVA', ativa: true, cep: '89010000', cod_municipio: '4202404', municipio: 'Blumenau', uf: 'SC',
      logradouro: 'Rua A', numero: '1', complemento: null, bairro: 'Centro', email: 'p@x.com', fone: '4733330000', op_simp_nac: 1 as const, cnae: '1091101', fonte: 'teste' });
    const res = await importarParaCarteira(1, [{ documento: '11222333000181' }, { documento: '39053344705', nome: 'Fulano de Tal' }], buscar);
    assert.ok(res.every((r) => r.ok), JSON.stringify(res));
    assert.match(res[0].mensagem, /Lucro Presumido/);
    const pad = db.prepare("SELECT regime, logradouro, na_carteira, gerencia FROM empresas WHERE documento = '11222333000181'").get() as any;
    assert.deepEqual([pad.regime, pad.logradouro, pad.na_carteira, pad.gerencia], ['PRESUMIDO', 'Rua A', 1, 0]);
    assert.equal((db.prepare("SELECT regime FROM empresas WHERE documento = '39053344705'").get() as any).regime, 'PF');
  } finally {
    await app.close();
  }
});
