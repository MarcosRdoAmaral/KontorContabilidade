import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigo, MODULOS_PAGOS };')();

test('módulos vendidos à parte: liberados no teste, só com o código KG3 na licença ativa, rotas e menu', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-mod-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0',
    KONTOR_MARCAS: fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-')), NFSE_MACHINE_ID: 'guid-modulos' });
  const { criarApp } = await import('../src/server.js');
  const L = await import('../src/licenca.js');
  const k = await ferr.gerarChaves();
  L._teste.chave = () => k.publica;
  L._teste.agora = () => new Date('2026-11-02T15:00:00Z');
  L._limparCacheModulos();
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    // o catálogo do gerador é o mesmo do sistema
    assert.deepEqual(Object.keys(ferr.MODULOS_PAGOS).sort(), Object.keys(L.MODULOS_PAGOS).sort());
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;

    // período de teste: tudo liberado para conhecer
    let lic = (await call('GET', '/api/licenca', undefined, t)).json;
    assert.equal(lic.estado, 'teste');
    assert.deepEqual(lic.modulos.sort(), ['cnd', 'radar']);
    assert.equal(lic.modulosPagos.radar.nome, 'Radar de Oportunidades');
    assert.equal(lic.modulosPagos.cnd, undefined, 'módulo ainda não lançado não aparece para venda');
    assert.equal((await call('GET', '/api/radar/config', undefined, t)).status, 200);
    let me = (await call('GET', '/api/me', undefined, t)).json;
    assert.ok(me.modulos.includes('radar')); assert.deepEqual(me.naoContratados, []);

    // licença paga sem módulo (KG2): o Radar fica bloqueado, inclusive para o administrador
    const kg2 = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2027-01-31', 'Escritório', 'prata', []);
    assert.match(kg2, /^KG2\./, 'sem módulo continua KG2 (aceito pelas versões anteriores)');
    assert.equal((await call('POST', '/api/licenca', { codigo: kg2 }, t)).status, 200);
    const bloq = await call('GET', '/api/radar/painel', undefined, t);
    assert.equal(bloq.status, 403); assert.match(bloq.json.erro, /Radar de Oportunidades não está contratado/);
    assert.equal((await call('PUT', '/api/radar/config', { provedor: 'DEMONSTRACAO' }, t)).status, 403);
    me = (await call('GET', '/api/me', undefined, t)).json;
    assert.ok(!me.modulos.includes('radar'));
    assert.deepEqual(me.naoContratados.map((m: any) => m.id), ['radar'], 'o menu mostra "contratar"');
    lic = (await call('GET', '/api/licenca', undefined, t)).json;
    assert.deepEqual(lic.modulos, []); assert.equal(lic.plano, 'prata');

    // KG3 com o Radar: liberado na hora, sem reiniciar
    const kg3 = await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2027-01-31', 'Escritório | Matriz', 'prata', ['radar', 'inexistente']);
    assert.match(kg3, /^KG3\./);
    lic = (await call('POST', '/api/licenca', { codigo: kg3 }, t)).json;
    assert.deepEqual(lic.modulos, ['radar']); assert.equal(lic.cliente, 'Escritório   Matriz'); assert.equal(lic.limites.clientes, 100);
    assert.equal((await call('GET', '/api/radar/painel', undefined, t)).status, 200);
    me = (await call('GET', '/api/me', undefined, t)).json;
    assert.ok(me.modulos.includes('radar')); assert.deepEqual(me.naoContratados, []);

    // módulo acrescentado ao código sem a assinatura é recusado
    const [a, p, g] = kg3.split('.');
    const forjado = [a, Buffer.from(Buffer.from(p, 'base64url').toString().replace('|radar|', '|radar,cnd|')).toString('base64url'), g].join('.');
    assert.equal((await call('POST', '/api/licenca', { codigo: forjado }, t)).status, 400);

    // licença vencida: módulo bloqueado
    L._teste.agora = () => new Date('2027-02-05T15:00:00Z');
    L._limparCacheModulos();
    assert.equal((await call('GET', '/api/radar/painel', undefined, t)).status, 403);
  } finally {
    await app.close();
  }
});
