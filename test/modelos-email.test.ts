import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-mod-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });

test('modelos de e-mail: texto sugerido, personalização, campos e prévia', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const E = await import('../src/servicos/email.js');
  const M = await import('../src/servicos/modelos-email.js');
  const enviados: any[] = [];
  E.trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, json: r.json() }; };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo Assessoria', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));

    // render: linha com campo vazio some; lista vira quadro; negrito
    const guias = [{ rotulo: 'DAS — Simples Nacional', valor: 'R$ 580,00', detalhe: 'Vencimento 20/11/2026' }];
    const r = M.renderizar(1, 'das', { cliente: 'Padaria Boa', contato: 'Ana', ...M.camposMes('2026-10'), guias });
    assert.equal(r.assunto, 'DAS do Simples Nacional 10/2026 | Padaria Boa');
    assert.equal(r.linhas[0], 'Olá, Ana!');
    assert.ok(r.linhas.includes('• DAS — Simples Nacional: R$ 580,00 · Vencimento 20/11/2026'));
    assert.match(r.linhas.join('\n'), /referente a outubro de 2026/);
    assert.match(r.html, /<strong>Padaria Boa<\/strong>/);
    assert.match(r.html, /R\$ 580,00<\/td>/);
    assert.ok(r.html.includes('<!--assinatura-->'));
    assert.doesNotMatch(r.linhas.join('\n'), /\{\{|\*\*/);
    const semContato = M.renderizar(1, 'boleto', { emitente: 'X', valor: 'R$ 1,00', vencimento: '01/12/2026' });
    assert.equal(semContato.linhas[0], 'Olá!');
    assert.ok(!semContato.linhas.some((l) => /linha digitável/i.test(l)), 'sem linha digitável, a frase some');

    // lista e personalização pela API
    const lista = (await call('GET', '/api/email/modelos', undefined, t)).json;
    assert.ok(lista.length >= 10); assert.ok(lista.every((m: any) => !m.personalizado));
    const das = lista.find((m: any) => m.chave === 'das');
    assert.ok(das.campos.some((c: any) => c.nome === 'guias' && c.lista));
    assert.equal((await call('PUT', '/api/email/modelos/das', { assunto: 'Guia {{competencia}}', corpo: 'Oi {{nome_errado}}' }, t)).status, 400);
    assert.equal((await call('PUT', '/api/email/modelos/xyz', { assunto: 'a', corpo: 'b' }, t)).status, 404);
    assert.equal((await call('PUT', '/api/email/modelos/das', { assunto: 'Sua guia {{competencia}}', corpo: '{{saudacao}}\n\nAqui está a guia:\n\n{{guias}}\n\n{{escritorio}}' }, t)).status, 200);
    assert.equal((await call('GET', '/api/email/modelos', undefined, t)).json.find((m: any) => m.chave === 'das').personalizado, true);
    const p = (await call('POST', '/api/email/modelos/das/previa', { assunto: 'Guia {{competencia}}', corpo: 'Oi {{xx}}\n{{guias}}' }, t)).json;
    assert.deepEqual(p.desconhecidos, ['xx']); assert.equal(p.assunto, 'Guia 10/2026');

    // o envio usa o texto personalizado, com a assinatura no lugar marcado
    await E.enviarComModelo(1, 'das', { cliente: 'Padaria', ...M.camposMes('2026-10'), guias }, ['c@x.com']);
    assert.equal(enviados[0].subject, 'Sua guia 10/2026');
    assert.match(enviados[0].text, /^Olá!\n\nAqui está a guia:\n\n• DAS/);
    assert.match(enviados[0].text, /Ciclo Assessoria$/);

    // teste para mim e restaurar o sugerido
    assert.equal((await call('POST', '/api/email/modelos/das/teste', { assunto: 'A {{cliente}}', corpo: 'B', para: 'eu@x.com' }, t)).status, 200);
    assert.equal(enviados[1].subject, '[Teste] A Padaria Pão Dourado'); assert.equal(enviados[1].to, 'eu@x.com');
    assert.equal((await call('DELETE', '/api/email/modelos/das', undefined, t)).status, 200);
    assert.equal(M.lerModelo(1, 'das').personalizado, false);
    // salvar igual ao sugerido não cria personalização
    assert.equal((await call('PUT', '/api/email/modelos/darf', { assunto: das.padrao.assunto.replace('DAS do Simples Nacional', 'x'), corpo: 'y' }, t)).status, 200);
    const darf = M.MODELOS.find((m) => m.chave === 'darf')!;
    await call('PUT', '/api/email/modelos/darf', { assunto: darf.assunto, corpo: darf.corpo }, t);
    assert.equal(M.lerModelo(1, 'darf').personalizado, false);
  } finally { await app.close(); }
});
