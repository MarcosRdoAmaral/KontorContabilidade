import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-dp-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });

test('envio automático do DP pela pasta do escritório', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const D = await import('../src/servicos/envio-dp.js');
  const enviados: any[] = [];
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, json: r.json() }; };
  try {
    assert.equal(D.tipoDoArquivo('Recibo Dctf Web.pdf'), 'RECIBO_DCTF');
    assert.equal(D.tipoDoArquivo('Recibo Mensal.pdf'), 'RECIBO');
    assert.equal(D.tipoDoArquivo('Darf Previdenciária.pdf'), 'DARF');
    assert.equal(D.tipoDoArquivo('E0003_Espelhoeresumodafolhadepagamento.pdf'), 'FOLHA');
    assert.equal(D.tipoDoArquivo('Boleto Sindicato.pdf'), 'SINDICATO');
    assert.equal(D.tipoDoArquivo('FGTS.pdf'), 'FGTS');
    assert.equal(D.tipoDoArquivo('FGTS.xlsx'), null);

    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: '06990590000123', razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t);
    const agro = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '04761525000109', razao_social: 'AGRO CONVENIENCIA RISTOW LTDA', regime: 'SIMPLES', tem_funcionarios: true, email: 'agro@x.com' }, t)).json.id;

    const raiz = path.join(tmp, 'Departamento Pessoal');
    const mes = (m: string) => path.join(raiz, 'Agro Conveniencia Ristow', m.slice(3), m);
    const velho = new Date(Date.now() - 3600e3);
    const poe = (m: string, nome: string, conteudo = '%PDF-1.4 x', recente = false) => { fs.mkdirSync(mes(m), { recursive: true }); const p = path.join(mes(m), nome); fs.writeFileSync(p, conteudo); if (!recente) fs.utimesSync(p, velho, velho); };
    poe('09-2026', 'Darf Previdenciária.pdf');                // antes da competência inicial: nunca vai
    poe('10-2026', 'E0003_Espelhoeresumodafolhadepagamento.pdf');
    poe('10-2026', 'Recibo Dctf Web.pdf');
    poe('10-2026', 'Recibo Mensal.pdf');
    poe('10-2026', 'Darf Previdenciária.pdf');

    assert.equal((await call('PUT', '/api/escritorio/envio-dp/config', { ligado: true, pasta: path.join(tmp, 'nao-existe'), desde: '2026-10' }, t)).status, 400);
    assert.equal((await call('PUT', '/api/escritorio/envio-dp/config', { ligado: true, pasta: raiz, desde: '2026-10' }, t)).status, 200);
    const painel = (await call('GET', '/api/escritorio/envio-dp', undefined, t)).json;
    assert.equal(painel.pastas[0].empresa_id, agro, 'pasta ligada ao cliente pelo nome');
    assert.deepEqual(painel.clientes.find((c: any) => c.id === agro).docs, ['DARF', 'FGTS', 'RECIBO'], 'padrão com funcionários');

    // falta o FGTS: espera
    let r = await D.varrerPastaDp(1, true);
    assert.deepEqual(r.map((x) => [x.competencia, x.situacao, x.faltando]), [['2026-10', 'AGUARDANDO', ['FGTS']]]);
    assert.equal(enviados.length, 0);
    // FGTS chegando ainda sendo gravado (agora mesmo): espera a próxima volta
    poe('10-2026', 'FGTS.pdf', '%PDF-1.4 y', true);
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'AGUARDANDO');
    fs.utimesSync(path.join(mes('10-2026'), 'FGTS.pdf'), velho, velho);
    // prévia não envia
    r = await D.varrerPastaDp(1, false);
    assert.equal(r[0].mensagem, 'pronto para enviar'); assert.equal(enviados.length, 0);
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'ENVIADO');
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, 'agro@x.com');
    assert.deepEqual(enviados[0].attachments.map((a: any) => a.filename).sort(), ['Darf Previdenciária.pdf', 'FGTS.pdf', 'Recibo Mensal.pdf'], 'só os documentos escolhidos');
    assert.match(enviados[0].subject, /10\/2026/);
    const dp = JSON.parse((db.prepare("SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = '2026-10' AND area = 'DP'").get(agro) as any).dados_json);
    assert.ok(dp.enviado, 'data de envio marcada');
    // nada novo: não envia de novo
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'JA_ENVIADO'); assert.equal(enviados.length, 1);
    // cliente passa a receber o espelho da folha: vai como complemento, só ele
    assert.equal((await call('PUT', `/api/escritorio/envio-dp/cliente/${agro}`, { dp_docs: ['DARF', 'FGTS', 'RECIBO', 'FOLHA'] }, t)).status, 200);
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'COMPLEMENTO');
    assert.deepEqual(enviados[1].attachments.map((a: any) => a.filename), ['E0003_Espelhoeresumodafolhadepagamento.pdf']);
    assert.match(enviados[1].subject, /complemento/);
    // DARF substituído (outro conteúdo): vai de novo como complemento
    poe('10-2026', 'Darf Previdenciária.pdf', '%PDF-1.4 retificado');
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'COMPLEMENTO');
    assert.deepEqual(enviados[2].attachments.map((a: any) => a.filename), ['Darf Previdenciária.pdf']);
    // envio desligado para o cliente
    await call('PUT', `/api/escritorio/envio-dp/cliente/${agro}`, { dp_envio_auto: false }, t);
    poe('10-2026', 'FGTS.pdf', '%PDF-1.4 z');
    r = await D.varrerPastaDp(1, true);
    assert.equal(r[0].situacao, 'DESLIGADO'); assert.equal(enviados.length, 3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dp_envios WHERE situacao = 'ENVIADO'").get() as any).n, 3);
  } finally {
    await app.close();
  }
});
