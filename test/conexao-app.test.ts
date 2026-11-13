import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { servidorConexao } from './fixtures/servidor-conexao.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-app-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', CONEXAO_AUTOMATICA: '0' });

const ESC = '06990590000123', ALFA = '45723174000110';
// linha digitável de arrecadação válida (módulo 11, 3º dígito 8)
function linhaValida() {
  const dv = (b: string) => { let s = 0; [...b].reverse().forEach((c, i) => { s += Number(c) * (2 + (i % 8)); }); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const blocos = ['85800000008', '12400328202', '61101182026', '11094572310'];
  return blocos.map((b) => `${b}-${dv(b)}`).join(' ');
}
function crc16(txt: string) {
  let crc = 0xffff;
  for (const b of Buffer.from(txt)) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const campo = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
const SEM_CRC = campo('00', '01') + campo('01', '12') + campo('26', campo('00', 'BR.GOV.BCB.PIX') + campo('25', 'qrpix.bradesco.com.br/qr/v2/cobv/abc1234567890123456789')) + campo('52', '0000') + campo('53', '986') + campo('54', '1240.00') + campo('58', 'BR') + campo('59', 'SECRETARIA DA RECEITA') + campo('60', 'BRASILIA') + campo('62', campo('05', '***')) + '6304';
const PIX = SEM_CRC + crc16(SEM_CRC);
const pdfGuia = () => new Promise<Buffer>((ok) => {
  const d = new PDFDocument({ size: 'A4' }); const p: Buffer[] = [];
  d.on('data', (x) => p.push(x)); d.on('end', () => ok(Buffer.concat(p)));
  d.fontSize(9).text('Documento de Arrecadação do Simples Nacional').text(linhaValida()).text('Pix Copia e Cola:').text(PIX, { width: 500 }).end();
});

test('aplicativo do celular: vários aparelhos, guia do mês com código de barras e Pix, sem repetir', async () => {
  const api = await servidorConexao();
  process.env.KONTOR_CONEXAO_URL = api.url;
  const { criarApp } = await import('../src/server.js');
  const n = await import('../src/conexao/nucleo.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    await call('POST', '/api/empresas', { documento: ESC, razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3, eh_escritorio: true }, t);
    const alfa = (await call('POST', '/api/escritorio/carteira', { documento: ALFA, razao_social: 'Alfa Engenharia', regime: 'SIMPLES', cod_municipio: '4202404', uf: 'SC', contato_fone: '47999990000' }, t)).json.id;
    const parear = async (extra: object) => {
      const cod = (await call('POST', `/api/escritorio/conexao/clientes/${alfa}/convite`, {}, t)).json.codigo;
      const ch = n.gerarChaves();
      const p = await n.chamarApi('POST', '/parear', { codigo: cod, cnpj: ALFA, chave: ch.publica, ...extra });
      return { token: p.token as string, chave: n.chaveSessao(ch.privada, p.escritorio.chave, ESC, ALFA), vinculo: p.vinculo as number };
    };
    const desktop = await parear({});
    const cel1 = await parear({ tipo: 'APP', dispositivo: 'iPhone da Joana' });
    const cel2 = await parear({ tipo: 'APP', dispositivo: 'Android do Pedro' });
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    let st = (await call('GET', `/api/escritorio/conexao/clientes/${alfa}`, undefined, t)).json;
    assert.equal(st.situacao, 'CONECTADO');
    assert.deepEqual(st.aparelhos.filter((a: any) => a.situacao === 'CONECTADO').map((a: any) => [a.tipo, a.nome]).sort(), [['APP', 'Android do Pedro'], ['APP', 'iPhone da Joana'], ['EMPRESAS', 'Kontor Gestão Empresas']]);
    assert.equal(st.aparelhos.find((a: any) => a.nome === 'iPhone da Joana').impressao, n.impressao(cel1.chave));

    // DAS do mês gerado no Controle mensal
    const pdf = await pdfGuia();
    db.prepare("INSERT INTO fechamentos (empresa_id, competencia, tipo, situacao, valor, vencimento, guia_pdf) VALUES (?, '2026-10', 'PGDASD', 'TRANSMITIDA', 1240, '2026-11-20', ?)").run(alfa, pdf);
    const env = (await call('POST', `/api/escritorio/fechamento/${alfa}/enviar?mes=2026-10`, { mes: '2026-10', canal: 'APP', tipo: 'PGDASD' }, t)).json;
    assert.equal(env.aparelhos, 3);
    assert.match(env.enviadoPara, /aplicativo \(3 aparelhos\)/);
    const recebe = async (a: { token: string; chave: Buffer }) => { const l: any[] = []; await n.buscarEnvelopes(a.token, () => a.chave, (e) => { l.push(e); }); return l; };
    for (const a of [desktop, cel1, cel2]) {
      const [g] = await recebe(a);
      assert.equal(g.tipo, 'GUIA');
      assert.deepEqual([g.dados.tipo, g.dados.valor, g.dados.validade, g.dados.competencia, g.dados.pedido], ['DAS', 1240, '2026-11-20', '2026-10', null]);
      assert.equal(g.dados.linha, linhaValida());
      assert.equal(g.dados.pix, PIX);
      assert.equal(Buffer.from(g.dados.pdf, 'base64').subarray(0, 4).toString(), '%PDF');
    }
    // WhatsApp do mesmo mês não manda de novo ao aplicativo
    const w = (await call('POST', `/api/escritorio/fechamento/${alfa}/enviar?mes=2026-10`, { mes: '2026-10', canal: 'WHATSAPP', tipo: 'PGDASD' }, t)).json;
    assert.equal(w.aparelhos, 0);
    assert.equal((await recebe(cel1)).length, 0);
    // mês seguinte pelo WhatsApp: vai ao aplicativo uma vez
    db.prepare("INSERT INTO fechamentos (empresa_id, competencia, tipo, situacao, valor, vencimento, guia_pdf) VALUES (?, '2026-11', 'PGDASD', 'TRANSMITIDA', 980, '2026-12-21', ?)").run(alfa, pdf);
    assert.equal((await call('POST', `/api/escritorio/fechamento/${alfa}/enviar?mes=2026-11`, { mes: '2026-11', canal: 'WHATSAPP', tipo: 'PGDASD' }, t)).json.aparelhos, 3);
    assert.equal((await call('POST', `/api/escritorio/fechamento/${alfa}/enviar?mes=2026-11`, { mes: '2026-11', canal: 'WHATSAPP', tipo: 'PGDASD' }, t)).json.aparelhos, 0);
    for (const a of [desktop, cel1, cel2]) assert.equal((await recebe(a)).length, 1);

    // pedido pelo celular, resposta vai a todos os aparelhos
    await n.enviarEnvelope(cel1.token, cel1.chave, 'PEDIDO_GUIA', { id: 'cel-pedido-01', tipo: 'DAS', periodo: '10/2026', data_pagamento: '2026-12-01', solicitante: 'Joana' });
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    const sol = (await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json[0];
    assert.equal(sol.solicitante, 'Joana, pelo celular');
    await call('POST', `/api/escritorio/solicitacoes/${sol.id}/recusar`, { mensagem: 'Já está pago.' }, t);
    assert.equal((await recebe(cel1))[0].dados.pedido, 'cel-pedido-01');
    assert.equal((await recebe(desktop))[0].tipo, 'PEDIDO_RESPOSTA');

    // foto de NFC-e pelo celular: chega em Fotos de notas, com a chave lida do QR Code; arquivo que não é imagem é descartado
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
    const CHAVE = '42261106990590000123650010000012341000012345';
    await n.enviarEnvelope(cel1.token, cel1.chave, 'NOTA_FOTO', { id: 'foto-0001', nome: 'nfce.jpg', mime: 'image/jpeg', arquivo: jpg.toString('base64'), chave: CHAVE, observacao: 'Gasolina do carro da empresa' });
    await n.enviarEnvelope(cel1.token, cel1.chave, 'NOTA_FOTO', { id: 'foto-0002', nome: 'x.jpg', mime: 'image/jpeg', arquivo: Buffer.alloc(300, 65).toString('base64') });
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    let fotos = (await call('GET', '/api/escritorio/notas-recebidas', undefined, t)).json;
    assert.deepEqual(fotos.map((f: any) => [f.cliente, f.nome, f.mime, f.tamanho, f.chave, f.observacao, f.enviado_por, f.situacao]), [['Alfa Engenharia', 'nfce.jpg', 'image/jpeg', 304, CHAVE, 'Gasolina do carro da empresa', 'iPhone da Joana', 'NOVA']]);
    const arq = await app.inject({ method: 'GET', url: `/api/escritorio/notas-recebidas/${fotos[0].id}/arquivo`, headers: { authorization: `Bearer ${t}` } });
    assert.deepEqual([arq.headers['content-type'], arq.headers['x-content-type-options'], arq.rawPayload.equals(jpg)], ['image/jpeg', 'nosniff', true]);
    assert.equal((await call('POST', `/api/escritorio/notas-recebidas/${fotos[0].id}/responder`, { situacao: 'REFAZER', mensagem: '' }, t)).status, 400);
    assert.equal((await call('POST', `/api/escritorio/notas-recebidas/${fotos[0].id}/responder`, { situacao: 'REFAZER', mensagem: 'Cortou o QR Code.' }, t)).json.avisado, true);
    assert.deepEqual((await recebe(cel1)).map((m: any) => [m.tipo, m.dados.id, m.dados.situacao, m.dados.mensagem]), [['NOTA_RESPOSTA', 'foto-0001', 'REFAZER', 'Cortou o QR Code.']]);
    await recebe(desktop);
    fotos = (await call('GET', '/api/escritorio/notas-recebidas', undefined, t)).json;
    assert.equal(fotos[0].situacao, 'REFAZER');
    assert.equal((await call('DELETE', `/api/escritorio/notas-recebidas/${fotos[0].id}`, undefined, t)).status, 200);
    assert.equal((await call('GET', '/api/escritorio/notas-recebidas', undefined, t)).json.length, 0);

    // desconectar um celular não afeta os outros
    st = (await call('DELETE', `/api/escritorio/conexao/clientes/${alfa}/aparelhos/${cel2.vinculo}`, undefined, t)).json;
    assert.equal(st.aparelhos.filter((a: any) => a.situacao === 'CONECTADO').length, 2);
    await assert.rejects(n.chamarApi('GET', '/vinculo', undefined, cel2.token), /escritório desfez/);
    assert.equal((await n.chamarApi('GET', '/vinculo', undefined, cel1.token)).dispositivo, 'iPhone da Joana');
    // o celular desfaz a conexão por conta própria: o escritório vê na sincronização
    await n.chamarApi('DELETE', '/vinculo', undefined, cel1.token);
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    st = (await call('GET', `/api/escritorio/conexao/clientes/${alfa}`, undefined, t)).json;
    assert.match(st.aparelhos.find((a: any) => a.nome === 'iPhone da Joana').motivo, /desfez a conexão no celular/);
    assert.equal(st.conectados, 1);
  } finally {
    await app.close();
    await api.fechar();
  }
});
