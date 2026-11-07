import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { servidorConexao } from './fixtures/servidor-conexao.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-conexao-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', CONEXAO_AUTOMATICA: '0' });

const ESC = '06990590000123', ALFA = '45723174000110';
const PDF = Buffer.from('%PDF-1.4 guia de teste').toString('base64');

test('criptografia: os dois lados chegam à mesma chave e a mensagem não abre com outra chave ou outro tipo', async () => {
  const { gerarChaves, chaveSessao, selar, abrir, impressao } = await import('../src/conexao/nucleo.js');
  const a = gerarChaves(), b = gerarChaves(), c = gerarChaves();
  const k1 = chaveSessao(a.privada, b.publica, ESC, ALFA), k2 = chaveSessao(b.privada, a.publica, ESC, ALFA);
  assert.deepEqual(k1, k2);
  assert.equal(impressao(k1), impressao(k2));
  assert.match(impressao(k1), /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const s = selar(k1, 'GUIA', { valor: 10.5, texto: 'ç' });
  assert.deepEqual(abrir(k2, 'GUIA', s), { valor: 10.5, texto: 'ç' });
  assert.throws(() => abrir(k2, 'FECHAMENTO', s), 'o tipo entra como dado autenticado');
  assert.throws(() => abrir(chaveSessao(c.privada, b.publica, ESC, ALFA), 'GUIA', s));
  assert.notDeepEqual(chaveSessao(a.privada, b.publica, ESC, '11222333000181'), k1, 'os CNPJs entram no contexto');
});

test('escritório conecta o cliente, recebe pedidos e fechamentos e devolve guias', async () => {
  const api = await servidorConexao();
  process.env.KONTOR_CONEXAO_URL = api.url;
  const { criarApp } = await import('../src/server.js');
  const nucleo = await import('../src/conexao/nucleo.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const alfa = (await call('POST', '/api/escritorio/carteira', { documento: ALFA, razao_social: 'Alfa Engenharia', regime: 'PRESUMIDO', cod_municipio: '4202404', uf: 'SC' }, t)).json.id;
    // sem a empresa do escritório não dá para conectar
    assert.match((await call('POST', `/api/escritorio/conexao/clientes/${alfa}/convite`, {}, t)).json.erro, /empresa do escritório/);
    await call('POST', '/api/empresas', { documento: ESC, razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3, eh_escritorio: true }, t);
    assert.equal((await call('GET', `/api/escritorio/conexao/clientes/${alfa}`, undefined, t)).json.situacao, 'NAO_CONECTADO');
    const conv = (await call('POST', `/api/escritorio/conexao/clientes/${alfa}/convite`, {}, t)).json;
    assert.equal(conv.situacao, 'CONVITE');
    assert.match(conv.codigo, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    // ---- lado do cliente (Kontor Empresas), direto pelo núcleo ----
    const ch = nucleo.gerarChaves();
    const par = await nucleo.chamarApi('POST', '/parear', { codigo: conv.codigo, cnpj: ALFA, nome: 'Alfa Engenharia', chave: ch.publica });
    assert.equal(par.escritorio.cnpj, ESC);
    const kCli = nucleo.chaveSessao(ch.privada, par.escritorio.chave, ESC, ALFA);
    const tokCli = par.token;

    // o escritório vê a conexão na sincronização; o código de segurança é o mesmo dos dois lados
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    const st = (await call('GET', `/api/escritorio/conexao/clientes/${alfa}`, undefined, t)).json;
    assert.equal(st.situacao, 'CONECTADO');
    assert.equal(st.codigo, null);
    assert.equal(st.impressao, nucleo.impressao(kCli));
    assert.equal((await call('GET', '/api/escritorio/carteira', undefined, t)).json.find((c: any) => c.id === alfa).conexao, 'CONECTADO');

    // pedidos de guia e fechamento (grande, em várias partes)
    await nucleo.enviarEnvelope(tokCli, kCli, 'PEDIDO_GUIA', { id: 'pedido-0001', tipo: 'DAS', periodo: '09/2026', data_pagamento: '2026-11-20', observacao: 'Atrasou', solicitante: 'Joana' });
    await nucleo.enviarEnvelope(tokCli, kCli, 'PEDIDO_GUIA', { id: 'pedido-0002', tipo: 'DARF', periodo: '08/2026', descricao: 'IRPJ', solicitante: 'Joana' });
    await nucleo.enviarEnvelope(tokCli, kCli, 'PEDIDO_GUIA', { id: 'pedido-0003', tipo: 'DCTFWEB', periodo: '10/2026', solicitante: 'Joana' });
    const zip = crypto.randomBytes(1_500_000); // não compacta: vai em mais de uma parte
    await nucleo.enviarEnvelope(tokCli, kCli, 'FECHAMENTO', { de: '2026-10-01', ate: '2026-10-31', nome: 'contabilidade_alfa_2026-10.zip', zip: zip.toString('base64'), arquivos: ['notas/1.xml', 'notas/1.pdf', 'extrato.ofx'], enviado_por: 'Joana' });
    await nucleo.enviarEnvelope(tokCli, kCli, 'PEDIDO_CANCELADO', { id: 'pedido-0003' });
    const s1 = (await call('POST', '/api/escritorio/conexao/sincronizar', {}, t)).json;
    assert.equal(s1.recebidos, 5);
    assert.deepEqual(s1.erros, []);
    let sol = (await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json;
    assert.equal(sol.length, 3);
    const das = sol.find((s: any) => s.tipo === 'DAS'), darf = sol.find((s: any) => s.tipo === 'DARF');
    assert.deepEqual([das.situacao, das.periodo, das.data_pagamento, das.observacao, das.solicitante, das.cliente], ['PENDENTE', '09/2026', '2026-11-20', 'Atrasou', 'Joana', 'Alfa Engenharia']);
    assert.equal(sol.find((s: any) => s.tipo === 'DCTFWEB').situacao, 'CANCELADA');
    // repetir a sincronização não duplica nada
    await call('POST', '/api/escritorio/conexao/sincronizar', {}, t);
    assert.equal((await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json.length, 3);
    const lem = (await call('GET', '/api/inicio', undefined, t)).json.lembretes.map((l: any) => l.texto).join(' | ');
    assert.match(lem, /2 pedidos de guia atualizada do Kontor Empresas aguardam resposta/);
    assert.match(lem, /1 fechamento recebido do Kontor Empresas ainda não foi baixado/);

    // fechamento recebido: lista e baixa o ZIP original
    const rec = (await call('GET', '/api/escritorio/recebidos', undefined, t)).json;
    assert.deepEqual([rec.length, rec[0].xml, rec[0].pdf, rec[0].ofx, rec[0].tamanho, rec[0].enviado_por], [1, 1, 1, 1, zip.length, 'Joana']);
    const baixado = await call('GET', `/api/escritorio/recebidos/${rec[0].id}/zip`, undefined, t);
    assert.deepEqual(Buffer.from(baixado.body), zip);
    assert.ok((await call('GET', '/api/escritorio/recebidos', undefined, t)).json[0].baixado_em);

    // DAS: não envia sem guia; anexa o PDF e envia
    assert.match((await call('POST', `/api/escritorio/solicitacoes/${das.id}/enviar`, {}, t)).json.erro, /Gere ou anexe/);
    assert.match((await call('POST', `/api/escritorio/solicitacoes/${das.id}/anexar`, { pdf: Buffer.from('não é pdf').toString('base64') }, t)).json.erro, /PDF/);
    assert.equal((await call('POST', `/api/escritorio/solicitacoes/${das.id}/anexar`, { pdf: PDF, valor: 1234.56, validade: '2026-11-20' }, t)).status, 200);
    assert.equal((await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json.find((s: any) => s.id === das.id).situacao, 'PRONTA');
    assert.equal((await call('POST', `/api/escritorio/solicitacoes/${das.id}/enviar`, { mensagem: 'Pague até sexta.' }, t)).status, 200);
    // DARF sem dados não gera; recusa com motivo
    assert.match((await call('POST', `/api/escritorio/solicitacoes/${darf.id}/gerar`, {}, t)).json.erro, /código da receita/);
    assert.match((await call('POST', `/api/escritorio/solicitacoes/${darf.id}/recusar`, { mensagem: '' }, t)).json.erro, /motivo/);
    assert.equal((await call('POST', `/api/escritorio/solicitacoes/${darf.id}/recusar`, { mensagem: 'Esse IRPJ já foi pago.' }, t)).status, 200);
    sol = (await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json;
    assert.deepEqual(sol.map((s: any) => s.situacao).sort(), ['CANCELADA', 'ENVIADA', 'RECUSADA']);
    assert.match((await call('POST', `/api/escritorio/solicitacoes/${darf.id}/recusar`, { mensagem: 'de novo' }, t)).json.erro, /já foi respondida/);

    // o cliente recebe a guia (com o PDF) e a recusa
    const chegou: any[] = [];
    const r = await nucleo.buscarEnvelopes(tokCli, () => kCli, (e) => { chegou.push(e); });
    assert.equal(r.recebidos, 2);
    const guia = chegou.find((e) => e.tipo === 'GUIA').dados;
    assert.deepEqual([guia.pedido, guia.tipo, guia.valor, guia.validade, guia.mensagem, guia.pdf], ['pedido-0001', 'DAS', 1234.56, '2026-11-20', 'Pague até sexta.', PDF]);
    assert.match(guia.nome, /^DAS-45723174000110-09-2026\.pdf$/);
    assert.deepEqual(chegou.find((e) => e.tipo === 'PEDIDO_RESPOSTA').dados, { pedido: 'pedido-0002', situacao: 'RECUSADO', mensagem: 'Esse IRPJ já foi pago.' });

    // guia avulsa (sem pedido) também pode ir
    const gid = (await call('GET', '/api/escritorio/solicitacoes', undefined, t)).json.find((s: any) => s.id === das.id).guia_id;
    assert.equal((await call('POST', `/api/escritorio/conexao/clientes/${alfa}/guias/${gid}/enviar`, {}, t)).status, 200);
    const avulsa: any[] = [];
    await nucleo.buscarEnvelopes(tokCli, () => kCli, (e) => { avulsa.push(e.dados); });
    assert.equal(avulsa[0].pedido, null);

    // desconectar: o cliente perde o acesso
    assert.equal((await call('DELETE', `/api/escritorio/conexao/clientes/${alfa}`, undefined, t)).json.situacao, 'DESCONECTADO');
    await assert.rejects(nucleo.chamarApi('GET', '/vinculo', undefined, tokCli), /escritório desfez/);
    assert.match((await call('POST', `/api/escritorio/conexao/clientes/${alfa}/guias/${gid}/enviar`, {}, t)).json.erro, /não está conectado/);
  } finally {
    await app.close();
    await api.fechar();
  }
});
