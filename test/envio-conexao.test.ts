import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { servidorConexao } from './fixtures/servidor-conexao.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-envio-cx-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', CONEXAO_AUTOMATICA: '0', ENVIO_DP_AUTOMATICO: '0' });
const ESC = '06990590000123', AGRO = '04761525000109';

test('sem o cliente pedir: guias do Controle mensal e documentos do DP vão sozinhos pela conexão', async () => {
  const api = await servidorConexao();
  process.env.KONTOR_CONEXAO_URL = api.url;
  const { criarApp } = await import('../src/server.js');
  const n = await import('../src/conexao/nucleo.js');
  const { db } = await import('../src/db.js');
  const D = await import('../src/servicos/envio-dp.js');
  const F = await import('../src/servicos/fechamento.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => { const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, json: r.json() }; };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: ESC, razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t);
    // cliente SEM e-mail: só a conexão leva os documentos
    const agro = (await call('POST', '/api/escritorio/carteira', { ...base, documento: AGRO, razao_social: 'AGRO CONVENIENCIA RISTOW LTDA', regime: 'SIMPLES', tem_funcionarios: true }, t)).json.id;
    const cod = (await call('POST', `/api/escritorio/conexao/clientes/${agro}/convite`, {}, t)).json.codigo;
    const ch = n.gerarChaves();
    const p = await n.chamarApi('POST', '/parear', { codigo: cod, cnpj: AGRO, chave: ch.publica, tipo: 'APP', dispositivo: 'Celular' });
    const k = n.chaveSessao(ch.privada, p.escritorio.chave, ESC, AGRO);
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    const recebe = async () => { const l: any[] = []; await n.buscarEnvelopes(p.token, () => k, (e) => { l.push(e); }); return l; };

    // ---- DP pela pasta: FGTS, DARF previdenciária e recibo ----
    const raiz = path.join(tmp, 'DP'), pasta = path.join(raiz, 'Agro Conveniencia Ristow', '2026', '10-2026');
    fs.mkdirSync(pasta, { recursive: true });
    const velho = new Date(Date.now() - 3600e3);
    for (const nome of ['FGTS.pdf', 'Darf Previdenciária.pdf', 'Recibo Mensal.pdf']) { const f = path.join(pasta, nome); fs.writeFileSync(f, `%PDF-1.4 ${nome}`); fs.utimesSync(f, velho, velho); }
    assert.equal((await call('PUT', '/api/escritorio/envio-dp/config', { ligado: true, pasta: raiz, desde: '2026-10' }, t)).status, 200);
    const r = await D.varrerPastaDp(1, true);
    assert.deepEqual(r.map((x) => [x.situacao, x.mensagem]), [['ENVIADO', 'enviado para aplicativo (1 aparelho)']]);
    const dp = await recebe();
    assert.deepEqual(dp.map((e) => [e.tipo, e.dados.tipo]).sort(), [['DOCUMENTO', 'RECIBO'], ['GUIA', 'DCTFWEB'], ['GUIA', 'FGTS']]);
    const fgts = dp.find((e) => e.dados.tipo === 'FGTS').dados;
    assert.deepEqual([fgts.titulo, fgts.periodo, fgts.competencia], ['Guia do FGTS — 10/2026', '10/2026', '2026-10']);
    assert.equal(Buffer.from(fgts.pdf, 'base64').toString(), '%PDF-1.4 FGTS.pdf');
    const rec = dp.find((e) => e.tipo === 'DOCUMENTO').dados;
    assert.deepEqual([rec.titulo, rec.nome, rec.mime, Buffer.from(rec.arquivo, 'base64').toString()], ['Recibo mensal (pró-labore) — 10/2026', 'Recibo Mensal.pdf', 'application/pdf', '%PDF-1.4 Recibo Mensal.pdf']);
    assert.equal((await D.varrerPastaDp(1, true))[0].situacao, 'JA_ENVIADO');

    // ---- Controle mensal: envio automático ----
    assert.equal((await call('GET', '/api/escritorio/conexao/automatico', undefined, t)).json.ligado, true);
    await F.envioAutomaticoFechamentos(); // primeira volta: só marca o começo
    const mesAtual = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
    // guia antiga (pronta antes de ligar): não vai
    db.prepare("INSERT INTO fechamentos (empresa_id, competencia, tipo, situacao, valor, vencimento, guia_pdf, atualizado_em) VALUES (?, ?, 'PGDASD', 'TRANSMITIDA', 500, '2026-12-20', ?, '2020-01-01 00:00:00')").run(agro, mesAtual, Buffer.from('%PDF-1.4 velha'));
    await F.envioAutomaticoFechamentos();
    assert.equal((await recebe()).length, 0);
    // DCTFWeb transmitida agora, com recibo: vai sozinha (guia + recibo), uma vez só
    db.prepare("INSERT INTO fechamentos (empresa_id, competencia, tipo, situacao, valor, vencimento, guia_pdf, recibo_pdf, atualizado_em) VALUES (?, ?, 'DCTFWEB', 'TRANSMITIDA', 321.5, '2026-12-19', ?, ?, datetime('now', '+1 second'))").run(agro, mesAtual, Buffer.from('%PDF-1.4 darf'), Buffer.from('%PDF-1.4 recibo'));
    await F.envioAutomaticoFechamentos();
    const auto = await recebe();
    assert.deepEqual(auto.map((e) => [e.tipo, e.dados.tipo]), [['GUIA', 'DCTFWEB'], ['DOCUMENTO', 'RECIBO_DCTF']]);
    assert.equal(auto[0].dados.valor, 321.5);
    await F.envioAutomaticoFechamentos();
    assert.equal((await recebe()).length, 0, 'não manda de novo');
    // desligado: nada vai sozinho
    assert.equal((await call('PUT', '/api/escritorio/conexao/automatico', { ligado: false }, t)).json.ligado, false);
    db.prepare("UPDATE fechamentos SET atualizado_em = datetime('now', '+2 seconds') WHERE tipo = 'PGDASD'").run();
    await F.envioAutomaticoFechamentos();
    assert.equal((await recebe()).length, 0);

    // ---- boleto de honorários (cobrança do escritório): vai sozinho; pagamento e cancelamento também ----
    const E = await import('../src/conexao/escritorio.js');
    assert.equal((await call('PUT', '/api/escritorio/conexao/automatico', { ligado: true }, t)).json.ligado, true);
    const escEmp = (db.prepare('SELECT id FROM empresas WHERE eh_escritorio = 1').get() as any).id;
    const tom = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome) VALUES (?, 'CNPJ', ?, 'AGRO CONVENIENCIA RISTOW LTDA')").run(escEmp, AGRO).lastInsertRowid);
    const PIX = '00020101021226580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-4266554400005204000053039865406450.005802BR5905CICLO6008BRUSQUE62070503***6304ABCD';
    const novaCob = (venc: string) => Number(db.prepare("INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status, forma, pix_copia_cola, criado_em) VALUES (?,?,?,?,?, 'REGISTRADO', 'PIX', ?, datetime('now', '+5 seconds'))")
      .run(escEmp, tom, 'Honorários contábeis', 450, venc, PIX).lastInsertRowid);
    const cob = novaCob('2026-12-10');
    await E.envioAutomaticoCobrancas();
    const bol = await recebe();
    assert.equal(bol.length, 1);
    assert.deepEqual([bol[0].tipo, bol[0].dados.tipo, bol[0].dados.valor, bol[0].dados.validade, bol[0].dados.pix, bol[0].dados.ref], ['GUIA', 'BOLETO', 450, '2026-12-10', PIX, `COB-${cob}`]);
    assert.match(bol[0].dados.titulo, /^Honorários — \d{2}\/\d{4}$/);
    assert.equal(Buffer.from(bol[0].dados.pdf, 'base64').subarray(0, 4).toString(), '%PDF');
    await E.envioAutomaticoCobrancas();
    assert.equal((await recebe()).length, 0, 'não repete');
    db.prepare("UPDATE cobrancas SET status = 'PAGO', pago_em = date('now'), valor_pago = 450 WHERE id = ?").run(cob);
    await E.envioAutomaticoCobrancas();
    const pago = await recebe();
    assert.deepEqual([pago[0].tipo, pago[0].dados.ref, pago[0].dados.valor_pago], ['PAGAMENTO', `COB-${cob}`, 450]);
    // cobrança cancelada depois de enviada: o cliente é avisado
    const cob2 = novaCob('2027-01-10');
    await E.envioAutomaticoCobrancas();
    assert.equal((await recebe()).length, 1);
    db.prepare("UPDATE cobrancas SET status = 'CANCELADO' WHERE id = ?").run(cob2);
    await E.envioAutomaticoCobrancas();
    assert.deepEqual((await recebe()).map((x) => [x.tipo, x.dados.ref]), [['COBRANCA_CANCELADA', `COB-${cob2}`]]);
  } finally {
    await app.close();
    await api.fechar();
  }
});
