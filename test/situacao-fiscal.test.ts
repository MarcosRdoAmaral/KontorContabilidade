import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-sitfis-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0' });

const ESC = '06990590000123', PADARIA = '11222333000181', ALFA = '45723174000110', SEMPROC = '27865757000102';

import { COM_PENDENCIAS, REGULAR, relatorioPdf } from './fixtures/situacao-fiscal.js';

test('leitura do relatório de situação fiscal', async () => {
  const { lerRelatorio, textoDoPdf } = await import('../src/servicos/situacao-fiscal.js');
  const r = lerRelatorio(await textoDoPdf(await relatorioPdf(COM_PENDENCIAS)));
  assert.equal(r.situacao, 'PENDENCIAS');
  assert.deepEqual(r.secoes.map((s) => [s.tipo, s.titulo, s.itens.length]), [
    ['PENDENCIA', 'Débito (SIEF)', 2], ['PENDENCIA', 'Omissão de DCTF (SIEF)', 1], ['PENDENCIA', 'Inscrição (SIDA)', 1], ['SUSPENSO', 'Débito com Exigibilidade Suspensa (SIEF)', 1],
  ]);
  const d = r.secoes[0].itens[0];
  assert.deepEqual([d.receita, d.descricao, d.periodo, d.vencimento, d.valorOriginal, d.saldo, d.situacao], ['1082-01', 'CP-SEGURADOS', '06/2026', '2026-07-20', 1234.56, 1526.57, 'DEVEDOR']);
  assert.equal(r.secoes[2].itens[0].saldo, 5432.1);
  assert.equal(r.qtdPendencias, 4);
  assert.equal(r.totalAberto, 7968.07, 'débitos consolidados + inscrição; suspenso não entra');
  assert.match(r.certidao ?? '', /positiva com efeitos de negativa/i);
  const reg = lerRelatorio(await textoDoPdf(await relatorioPdf(REGULAR)));
  assert.deepEqual([reg.situacao, reg.qtdPendencias, reg.totalAberto], ['REGULAR', 0, 0]);
  assert.equal(lerRelatorio('texto qualquer').situacao, 'VERIFICAR');
});

test('consulta da situação fiscal pelo Integra Contador', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: ESC, razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t);
    const ids: Record<string, number> = {};
    for (const doc of [PADARIA, ALFA, SEMPROC]) ids[doc] = (await call('POST', '/api/escritorio/carteira', { ...base, documento: doc, razao_social: `Cliente ${doc}`, regime: 'SIMPLES' }, t)).json.id;

    const pdfPend = (await relatorioPdf(COM_PENDENCIAS)).toString('base64'), pdfReg = (await relatorioPdf(REGULAR)).toString('base64');
    const chamadas: string[] = [];
    const emitirFila: Record<string, any[]> = {
      [PADARIA]: [{ tempoEspera: 2000 }, { pdf: pdfPend }],
      [ALFA]: [{ tempoEspera: 60000 }, { pdf: pdfReg }],
    };
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any, _t: any, endpoint?: string) {
        const doc = corpo.contribuinte.numero, srv = corpo.pedidoDados.idServico;
        chamadas.push(`${endpoint}:${srv}:${doc}`);
        if (doc === SEMPROC) return { status: 403, corpo: { status: 403, mensagens: [{ codigo: 'AcessoNegado-SITFIS', texto: 'Não há procuração.' }], dados: '' } };
        if (srv === 'SOLICITARPROTOCOLO91') { assert.equal(endpoint, 'Apoiar'); return { status: 200, corpo: { status: 200, mensagens: [{ codigo: '[Sucesso-Sitfis-SC01]', texto: 'ok' }], dados: JSON.stringify({ protocoloRelatorio: `P-${doc}`, tempoEspera: 3000 }) } }; }
        assert.equal(endpoint, 'Emitir'); assert.equal(srv, 'RELATORIOSITFIS92');
        assert.deepEqual(JSON.parse(corpo.pedidoDados.dados), { protocoloRelatorio: `P-${doc}` });
        const d = emitirFila[doc].shift();
        return { status: d.pdf ? 200 : 202, corpo: { status: d.pdf ? 200 : 202, mensagens: [{ codigo: d.pdf ? '[Sucesso-Sitfis-SC02]' : '[Aviso-Sitfis-AV01]', texto: '' }], dados: JSON.stringify(d) } };
      },
    };
    const esperas: number[] = [];
    const esperar = async (ms: number) => { esperas.push(ms); };
    const { consultarVarios, consultarSituacao } = await import('../src/servicos/situacao-fiscal.js');
    const r = await consultarVarios(1, 1, [ids[PADARIA], ids[ALFA], ids[SEMPROC]], { transporte, esperar });
    assert.deepEqual([r.prontos, r.comPendencias, r.aguardando, r.erros], [1, 1, 1, 1]);
    assert.deepEqual(esperas.slice(0, 2), [3000, 2000], 'espera o tempo pedido pelo SERPRO');
    const sem = r.resultados.find((x) => x.empresa_id === ids[SEMPROC])!;
    assert.match(sem.mensagem, /procuração/);
    const alfa = r.resultados.find((x) => x.empresa_id === ids[ALFA])!;
    assert.equal(alfa.status, 'SOLICITADA'); assert.match(alfa.mensagem, /Atualizar daqui a 60/);
    // atualizar reaproveita o protocolo (não pede outro)
    chamadas.length = 0;
    const r2 = await consultarSituacao(1, 1, ids[ALFA], { transporte, esperar });
    assert.equal(r2.situacao, 'REGULAR');
    assert.deepEqual(chamadas, [`Emitir:RELATORIOSITFIS92:${ALFA}`]);

    // ---------- tela ----------
    const painel = (await call('GET', '/api/escritorio/situacao-fiscal', undefined, t)).json;
    assert.equal(painel.clientes[0].empresa_id, ids[PADARIA], 'quem tem pendência vem primeiro');
    assert.deepEqual([painel.resumo.comPendencias, painel.resumo.regulares, painel.resumo.totalAberto], [1, 1, 7968.07]);
    const det = (await call('GET', `/api/escritorio/situacao-fiscal/${painel.clientes[0].id}`, undefined, t)).json;
    assert.equal(det.resumo.secoes[0].itens[1].receita, '2172-01'); assert.equal(det.historico.length, 1);
    const pdf = await call('GET', `/api/escritorio/situacao-fiscal/${painel.clientes[0].id}/pdf`, undefined, t);
    assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');
    const vg = (await call('GET', '/api/escritorio/visao?mes=2026-10', undefined, t)).json;
    assert.equal(vg.situacaoFiscal.comPendencias, 1);
    // pela API, sem Integra configurado: erro explicado, sem travar a lista
    const api = (await call('POST', '/api/escritorio/situacao-fiscal/consultar', { ids: [ids[ALFA]] }, t)).json;
    assert.equal(api.erros, 1); assert.match(api.resultados[0].mensagem, /Integra Contador/);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM situacao_fiscal').get());
  } finally {
    await app.close();
  }
});
