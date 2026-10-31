import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-ass-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });

test('assinatura em imagem no fim dos e-mails', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const E = await import('../src/servicos/email.js');
  const enviados: any[] = [];
  E.trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, body: r.rawPayload, tipo: r.headers['content-type'] }; };
  try {
    const t = JSON.parse((await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).body.toString()).token;
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));
    // sem assinatura: e-mail como antes
    await E.enviarEmailSimples(1, ['c@x.com'], 'A', ['Olá']);
    assert.ok(!enviados[0].html.includes('cid:assinatura'));
    assert.equal((await call('GET', '/api/email/assinatura', undefined, t)).status, 404);
    assert.equal((await call('PUT', '/api/email/assinatura', { imagem: 'data:text/plain;base64,QUJD' }, t)).status, 400);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    assert.equal((await call('PUT', '/api/email/assinatura', { imagem: `data:image/png;base64,${png.toString('base64')}` }, t)).status, 200);
    const g = await call('GET', '/api/email/assinatura', undefined, t);
    assert.equal(g.status, 200); assert.equal(g.tipo, 'image/png'); assert.deepEqual(g.body, png);
    await E.enviarEmailSimples(1, ['c@x.com'], 'B', ['Olá', 'Tchau'], [{ filename: 'guia.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }]);
    const m = enviados[1];
    assert.match(m.html, /Tchau<\/p><p style="margin:20px 0 0"><img src="cid:assinatura@kontor"/, 'imagem depois do texto');
    assert.deepEqual(m.attachments.map((a: any) => [a.filename, a.cid]), [['guia.pdf', undefined], ['assinatura.png', 'assinatura@kontor']]);
    await E.testarConfig(1, 'c@x.com');
    assert.ok(enviados[2].html.includes('cid:assinatura@kontor'), 'o e-mail de teste mostra a assinatura');
    assert.equal((await call('PUT', '/api/email/assinatura', { imagem: null }, t)).status, 200);
    await E.enviarEmailSimples(1, ['c@x.com'], 'C', ['Olá']);
    assert.ok(!enviados[3].html.includes('cid:assinatura'));
  } finally {
    await app.close();
  }
});
