import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-proc-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 30 -subj "/CN=CICLO ASSESSORIA:06990590000123" 2>/dev/null && openssl pkcs12 -export -inkey ${tmp}/k.pem -in ${tmp}/c.pem -out ${tmp}/t.pfx -passout pass:1234`);

test('NFS-e por procuração: certificado do escritório para emitir e buscar as notas do cliente', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { certificadoNfse } = await import('../src/servicos/emissao.js');
  const { statusCaptura } = await import('../src/servicos/captura.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.body };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const esc = (await call('POST', '/api/empresas', { documento: '06990590000123', razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3, eh_escritorio: true }, t)).json.id;
    const cli = (await call('POST', '/api/escritorio/carteira', { documento: '11222333000181', razao_social: 'Padaria Boa Ltda', regime: 'SIMPLES', cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' }, t)).json.id;
    // sem o certificado do escritório não liga
    assert.equal((await call('PUT', `/api/escritorio/captura/${cli}/procuracao`, { ativo: true }, t)).status, 400);
    const b = '----x';
    const up = await app.inject({ method: 'POST', url: `/api/empresas/${esc}/certificado`, headers: { authorization: `Bearer ${t}`, 'content-type': `multipart/form-data; boundary=${b}` },
      payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="senha"\r\n\r\n1234\r\n--${b}\r\nContent-Disposition: form-data; name="arquivo"; filename="t.pfx"\r\nContent-Type: application/x-pkcs12\r\n\r\n`), fs.readFileSync(`${tmp}/t.pfx`), Buffer.from(`\r\n--${b}--\r\n`)]) });
    assert.equal(up.statusCode, 200, up.body);
    const linha = () => statusCaptura(1, '2026-11').find((l: any) => l.id === cli)!;
    assert.equal(linha().pode_adn, false, 'sem A1 e sem procuração não busca');
    assert.throws(() => certificadoNfse(db.prepare('SELECT * FROM empresas WHERE id = ?').get(cli)), /certificado A1/);
    assert.equal((await call('PUT', `/api/escritorio/captura/${cli}/procuracao`, { ativo: true }, t)).status, 200);
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(cli) as any;
    assert.equal(empresa.nfse_procuracao, 1);
    assert.match(certificadoNfse(empresa).documento ?? '', /06990590/, 'usa o certificado do escritório');
    assert.equal(linha().procuracao_ok, true); assert.equal(linha().pode_adn, true);
    // o escritório não vira procurador de si mesmo
    assert.equal((await call('PUT', `/api/escritorio/captura/${esc}/procuracao`, { ativo: true }, t)).status, 200);
    assert.equal((db.prepare('SELECT nfse_procuracao FROM empresas WHERE id = ?').get(esc) as any).nfse_procuracao, 0);
    // busca no ADN: mesmo caminho da busca com A1 (consulta injetada)
    const { buscarNoAdn } = await import('../src/servicos/nfse-capturadas.js');
    const r = await buscarNoAdn(cli, { consultar: async () => ({ status: 200, corpo: { StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO' } }) });
    assert.equal(r.consultou, true);
    assert.equal((await call('PUT', `/api/escritorio/captura/${cli}/procuracao`, { ativo: false }, t)).status, 200);
  } finally { await app.close(); }
});

test('ADN com procuração consulta o CNPJ do cliente (cnpjConsulta)', async () => {
  const { consultaAdn } = await import('../src/nfse/adn.js');
  const https = await import('node:https');
  const urls: string[] = [];
  const orig = https.default.request;
  (https.default as any).request = (url: string, _o: any, cb: any) => { urls.push(url); const r = new EventEmitter(); (r as any).end = () => { const res = new EventEmitter(); (res as any).statusCode = 204; cb(res); res.emit('end'); }; (r as any).destroy = () => {}; return r; };
  try {
    const cert = { chavePem: '', cadeiaPem: '' } as any;
    await consultaAdn(cert, 1, '11222333000181').consultar(5);
    await consultaAdn(cert, 1).consultar(5);
  } finally { (https.default as any).request = orig; }
  assert.match(urls[0], /\/DFe\/5\?cnpjConsulta=11222333000181$/);
  assert.match(urls[1], /\/DFe\/5$/);
});
