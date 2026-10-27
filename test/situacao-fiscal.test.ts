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

test('leitura do relatório de situação fiscal (formato real, páginas giradas)', async () => {
  const { lerRelatorio, textoDoPdf } = await import('../src/servicos/situacao-fiscal.js');
  for (const girado of [true, false]) {
    const r = lerRelatorio(await textoDoPdf(await relatorioPdf(COM_PENDENCIAS, { girado })));
    assert.equal(r.situacao, 'PENDENCIAS', `girado=${girado}`);
    assert.deepEqual(r.secoes.map((s) => [s.tipo, s.orgao, s.titulo, s.itens.length]), [
      ['PENDENCIA', 'RFB', 'Débito (SIEF)', 3],
      ['SUSPENSO', 'RFB', 'Débito com Exigibilidade Suspensa (SIEF)', 1],
      ['SUSPENSO', 'RFB', 'Parcelamento com Exigibilidade Suspensa (SIEFPAR)', 1],
      ['PENDENCIA', 'PGFN', 'Inscrição (SIDA)', 2],
    ], `girado=${girado}`);
    const [maed, patronal, terceiros] = r.secoes[0].itens;
    assert.deepEqual([maed.receita, maed.descricao, maed.periodo, maed.vencimento, maed.valorOriginal, maed.saldo, maed.situacao, maed.notificacao],
      ['1345-01', 'MAED - DCTF', '22/04/2024', '2026-07-01', 200, 206.34, 'DEVEDOR', '14174877105630']);
    assert.deepEqual([patronal.periodo, patronal.saldoDevedor, patronal.saldo], ['07/2026', 4022.88, 4911.12]);
    assert.equal(terceiros.periodo, '2025');
    const [simples, cofins] = r.secoes[3].itens;
    assert.deepEqual([simples.tipo, simples.inscricao, simples.receita, simples.descricao, simples.inscritoEm, simples.processo, simples.situacao],
      ['INSCRICAO', '91.4.21.019567-04', '1507', 'SIMPLES NACIONAL', '2021-04-05', '12376.267.430/2021-63', 'ATIVA AJUIZADA']);
    assert.equal(cofins.situacao, 'ATIVA A SER COBRADA');
    assert.deepEqual([r.secoes[2].itens[0].tipo, r.secoes[2].itens[0].saldo, r.secoes[2].itens[0].descricao], ['PARCELAMENTO', 71447.12, 'Parcelamento Simplificado']);
    assert.equal(r.totalAberto, 5129.42, 'soma dos débitos do SIEF (consolidado); suspensos e inscrições sem valor não entram');
    assert.deepEqual([r.qtdPendencias, r.qtdInscricoes], [5, 2]);
    assert.deepEqual([r.certidao, r.certidaoValidade], ['Positiva com Efeitos de Negativa', '2026-10-03']);
  }
  const reg = lerRelatorio(await textoDoPdf(await relatorioPdf(REGULAR, { girado: true })));
  assert.deepEqual([reg.situacao, reg.qtdPendencias, reg.totalAberto, reg.certidao, reg.certidaoValidade], ['REGULAR', 0, 0, 'Negativa', '2027-03-30']);
  assert.equal(lerRelatorio('texto qualquer').situacao, 'VERIFICAR');
});

test('agenda mensal: datas das ocorrências', async () => {
  const { ocorrenciaDevida, proximaOcorrencia } = await import('../src/servicos/situacao-fiscal.js');
  assert.equal(ocorrenciaDevida([1, 15], '2026-10-27'), '2026-10-15');
  assert.equal(ocorrenciaDevida([1, 15], '2026-10-10'), '2026-10-01');
  assert.equal(ocorrenciaDevida([5], '2026-01-03'), '2025-12-05', 'antes do dia: vale a do mês anterior');
  assert.equal(proximaOcorrencia([1, 15], '2026-10-27'), '2026-11-01');
  assert.equal(proximaOcorrencia([1, 15], '2026-10-01'), '2026-10-15');
  assert.equal(proximaOcorrencia([10], '2026-12-20'), '2027-01-10');
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

    const pdfPend = (await relatorioPdf(COM_PENDENCIAS, { girado: true })).toString('base64'), pdfReg = (await relatorioPdf(REGULAR)).toString('base64');
    const chamadas: string[] = [];
    const emitirFila: Record<string, any[]> = {
      [PADARIA]: [{ tempoEspera: 2000 }, { pdf: pdfPend }],
      [ALFA]: [{ tempoEspera: 60000 }, { pdf: pdfReg }],
    };
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any, _t: any, endpoint?: string) {
        const doc = corpo.contribuinte.numero, srv = corpo.pedidoDados.idServico;
        assert.equal(corpo.pedidoDados.versaoSistema, '2.0', 'SITFIS está na versão 2.0 do catálogo');
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
    assert.deepEqual([painel.resumo.comPendencias, painel.resumo.regulares, painel.resumo.totalAberto], [1, 1, 5129.42]);
    const det = (await call('GET', `/api/escritorio/situacao-fiscal/${painel.clientes[0].id}`, undefined, t)).json;
    assert.equal(det.resumo.secoes[0].itens[1].receita, '1138-01'); assert.equal(det.historico.length, 1);
    const pdf = await call('GET', `/api/escritorio/situacao-fiscal/${painel.clientes[0].id}/pdf`, undefined, t);
    assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');
    const vg = (await call('GET', '/api/escritorio/visao?mes=2026-10', undefined, t)).json;
    assert.equal(vg.situacaoFiscal.comPendencias, 1);
    // pela API, sem Integra configurado: erro explicado, sem travar a lista
    const api = (await call('POST', '/api/escritorio/situacao-fiscal/consultar', { ids: [ids[ALFA]] }, t)).json;
    assert.equal(api.erros, 1); assert.match(api.resultados[0].mensagem, /Integra Contador/);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM situacao_fiscal').get());

    // ---------- releitura de relatórios lidos pela versão antiga ----------
    const { relerRelatoriosAntigos } = await import('../src/servicos/situacao-fiscal.js');
    const idPend = painel.clientes[0].id;
    db.prepare("UPDATE situacao_fiscal SET situacao = 'VERIFICAR', resumo_json = '{}', concluida_em = '2026-10-01 10:00:00' WHERE id = ?").run(idPend);
    assert.ok((await relerRelatoriosAntigos()) >= 1);
    const relido = db.prepare('SELECT situacao, concluida_em, total_aberto FROM situacao_fiscal WHERE id = ?').get(idPend) as any;
    assert.deepEqual([relido.situacao, relido.concluida_em, relido.total_aberto], ['PENDENCIAS', '2026-10-01 10:00:00', 5129.42], 'relê sem trocar a data da consulta');
    assert.equal(await relerRelatoriosAntigos(), 0, 'só uma vez');

    // ---------- consulta automática ----------
    const email = await import('../src/servicos/email.js');
    const enviados: any[] = [];
    email.trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
    email.salvarConfig(1, { host: 'smtp.x.com', port: 587, secure: false, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' } as any);
    assert.equal((await call('PUT', '/api/escritorio/situacao-fiscal/agenda', { ativo: true, dias: [1, 15, 20] }, t)).status, 400, 'no máximo dois dias');
    const ag = (await call('PUT', '/api/escritorio/situacao-fiscal/agenda', { ativo: true, dias: [15, 1], emails: ['contador@x.com'] }, t)).json;
    assert.deepEqual(ag.dias, [1, 15]); assert.equal(ag.chamadasPorMes, 3 * 2 * 2);
    const { sitfisAutomatico, lerAgenda } = await import('../src/servicos/situacao-fiscal.js');
    const proxima = ag.proxima as string;
    // antes do dia: não roda
    assert.deepEqual(await sitfisAutomatico(new Date(`${proxima}T09:00:00-03:00`.replace(proxima, new Date(Date.parse(proxima) - 864e5).toISOString().slice(0, 10))), { transporte, esperar }), []);
    // no dia, a partir das 7h: consulta todos os clientes ativos
    emitirFila[PADARIA] = [{ pdf: pdfPend }]; emitirFila[ALFA] = [{ tempoEspera: 90000 }, { pdf: pdfReg }];
    db.prepare("UPDATE situacao_fiscal SET solicitada_em = datetime('now', '-13 hours')").run(); // protocolos antigos vencidos
    chamadas.length = 0;
    const f1 = await sitfisAutomatico(new Date(`${proxima}T10:00:00-03:00`), { transporte, esperar });
    assert.deepEqual(f1, [{ escritorio: 1, consultados: 3 }]);
    assert.equal(chamadas.filter((c) => c.startsWith('Apoiar')).length, 3);
    const a1 = lerAgenda(1);
    assert.equal(a1.ultimaOcorrencia, proxima); assert.match(a1.ultimoResultado!, /1 com pendências .*1 aguardando a Receita.*1 com erro.*E-mail enviado/);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].subject, /Situação fiscal dos clientes/);
    assert.match(enviados[0].text, /CONTINUAM COM PENDÊNCIAS\n• Cliente 11222333000181: 5 pendência\(s\)/, 'a Padaria já tinha pendência');
    assert.match(enviados[0].text, /NÃO FOI POSSÍVEL CONSULTAR\n• Cliente 27865757000102: Sem procuração/);
    assert.match(enviados[0].text, /AINDA EM GERAÇÃO/);
    // mesma ocorrência: não consulta de novo; o relatório pendente é buscado quando liberar
    chamadas.length = 0;
    const f3 = await sitfisAutomatico(new Date(`${proxima}T10:30:00-03:00`), { transporte, esperar });
    assert.deepEqual(f3, [{ escritorio: 1, consultados: 1 }], 'só o relatório que ficou pendente');
    assert.deepEqual(chamadas, [`Emitir:RELATORIOSITFIS92:${ALFA}`]);
    assert.equal(enviados.length, 1, 'e-mail só na rodada do dia');
    // desligada: não roda
    await call('PUT', '/api/escritorio/situacao-fiscal/agenda', { ativo: false, dias: [1, 15], emails: [] }, t);
    assert.deepEqual(await sitfisAutomatico(new Date(`${proxima.slice(0, 8)}28T10:00:00-03:00`), { transporte, esperar }), []);
  } finally {
    await app.close();
  }
});
