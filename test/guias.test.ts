import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { COM_PENDENCIAS, relatorioPdf } from './fixtures/situacao-fiscal.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-guias-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

const ESC = '06990590000123', PADARIA = '11222333000181', ALFA = '45723174000110';
const PDF = Buffer.from('%PDF-1.4 guia').toString('base64');

test('sugestão de guia e períodos do Sicalc', async () => {
  const { sugestaoGuia, periodoSicalc } = await import('../src/servicos/guias.js');
  assert.deepEqual(periodoSicalc('07/2026'), { tipoPA: 'ME', dataPA: '07/2026' });
  assert.deepEqual(periodoSicalc('2025'), { tipoPA: 'AN', dataPA: '2025' });
  assert.deepEqual(periodoSicalc('22/04/2024'), { tipoPA: 'DI', dataPA: '22/04/2024' });
  assert.equal(sugestaoGuia({ tipo: 'DEBITO', texto: '', receita: '1138-01', descricao: 'CP-PATRONAL', periodo: '07/2026' })?.tipo, 'DCTFWEB');
  const maed = sugestaoGuia({ tipo: 'DEBITO', texto: '', receita: '1345-01', descricao: 'MAED - DCTF', periodo: '22/04/2024', vencimento: '2026-07-01', saldoDevedor: 200, notificacao: '14174877105630' }) as any;
  assert.deepEqual([maed.tipo, maed.receita, maed.valor, maed.referencia], ['DARF', '1345-01', 200, '14174877105630']);
  assert.equal(sugestaoGuia({ tipo: 'OUTRO', texto: 'PA 03/2026 vencimento 20/04/2026 valor 1.234,00' }, 'Pendência - Débito (Simples Nacional)')?.tipo, 'DAS');
  assert.equal(sugestaoGuia({ tipo: 'INSCRICAO', texto: '', inscricao: '91.4.21.019567-04' }), null);
  // débitos do Simples Nacional vêm sem código de receita no relatório
  const { lerRelatorio, textoDoPdf } = await import('../src/servicos/situacao-fiscal.js');
  const S = '_'.repeat(40);
  const rel = lerRelatorio(await textoDoPdf(await relatorioPdf([`${S} Diagnóstico Fiscal na Receita Federal ${S}`, `Pendência - Débito (SIEF) ${S}`, 'CNPJ: 11.222.333/0001-81',
    ['Receita', 'PA/Exerc.', 'Dt. Vcto', 'Vl. Original', 'Sdo. Devedor', 'Multa', 'Juros', 'Sdo. Dev. Cons.', 'Situação'],
    ['SIMPLES NAC.', '01/2026', '20/02/2026', '2.096,20', '2.096,20', '419,24', '186,14', '2.701,58', 'DEVEDOR'],
    ['SIMPLES NAC.', '09/2026', '20/10/2026', '3.327,76', '3.327,76', '87,85', '0,00', '3.415,61', 'DEVEDOR'], 'Final do Relatório'], { girado: true })));
  const sn = rel.secoes[0].itens;
  assert.deepEqual(sn.map((i) => [i.tipo, i.periodo, i.vencimento, i.saldoDevedor, i.saldo]), [['DEBITO', '01/2026', '2026-02-20', 2096.2, 2701.58], ['DEBITO', '09/2026', '2026-10-20', 3327.76, 3415.61]]);
  assert.equal(rel.totalAberto, 6117.19);
  assert.deepEqual(sugestaoGuia(sn[0], rel.secoes[0].titulo), { tipo: 'DAS', periodo: '01/2026', descricao: 'Simples Nacional' });
});

test('recalcular guias pelo Integra Contador e avisar só os clientes marcados', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const enviados: any[] = [];
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    await call('POST', '/api/empresas', { documento: ESC, razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3, eh_escritorio: true }, t);
    const pad = (await call('POST', '/api/escritorio/carteira', { documento: PADARIA, razao_social: 'Padaria Boa', regime: 'PRESUMIDO', cod_municipio: '4202404', uf: 'SC', email: 'padaria@x.com' }, t)).json.id;
    const alfa = (await call('POST', '/api/escritorio/carteira', { documento: ALFA, razao_social: 'Alfa', regime: 'PRESUMIDO', cod_municipio: '4202404', uf: 'SC', email: 'alfa@x.com' }, t)).json.id;

    // ---------- guias ----------
    const pedidos: any[] = [];
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any, _t: any, endpoint: string) {
        pedidos.push({ corpo, endpoint, dados: JSON.parse(corpo.pedidoDados.dados) });
        const s = corpo.pedidoDados.idServico;
        if (s === 'CONSOLIDARGERARDARF51') return { status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify({ consolidado: { valorTotalConsolidado: 250.5, dataValidadeCalculo: '2026-10-30T00:00:00' }, darf: PDF }) } };
        if (s === 'GERARDASCOBRANCA17') return { status: 403, corpo: { status: 403, mensagens: [{ codigo: 'AcessoNegado-PGDASD', texto: 'Não há procuração.' }], dados: '' } };
        if (s === 'GERARGUIA31') return { status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify({ PDFByteArrayBase64: PDF }) } };
        throw new Error(s);
      },
    };
    const { gerarGuia } = await import('../src/servicos/guias.js');
    const g = await gerarGuia(1, 1, pad, { tipo: 'DARF', receita: '1345-01', descricao: 'MAED - DCTF', periodo: '22/04/2024', vencimento: '2026-07-01', valor: 200, data: '2026-10-30', referencia: '14174877105630' }, transporte as any);
    const p0 = pedidos[0];
    assert.equal(p0.endpoint, 'Emitir'); assert.equal(p0.corpo.pedidoDados.versaoSistema, '2.9');
    assert.deepEqual([p0.dados.uf, p0.dados.municipio, p0.dados.codigoReceita, p0.dados.codigoReceitaExtensao, p0.dados.tipoPA, p0.dados.dataPA, p0.dados.vencimento, p0.dados.valorImposto, p0.dados.dataConsolidacao, p0.dados.numeroReferencia],
      ['SC', 8047, '1345', '01', 'DI', '22/04/2024', '2026-07-01T00:00:00', '200.00', '2026-10-30T00:00:00', '14174877105630'], 'Blumenau no Sicalc é 8047 (SIAFI)');
    assert.deepEqual([g.valor, g.validade], [250.5, '2026-10-30']);
    const pdf = await call('GET', `/api/escritorio/guias/${g.id}/pdf`, undefined, t);
    assert.equal(pdf.status, 200); assert.ok(pdf.body.toString().startsWith('%PDF'));
    await assert.rejects(gerarGuia(1, 1, pad, { tipo: 'DAS', periodo: '07/2026' }, transporte as any), /procuração/);
    const gd = await gerarGuia(1, 1, pad, { tipo: 'DCTFWEB', periodo: '07/2026', data: '2026-10-30' }, transporte as any);
    assert.deepEqual(pedidos.at(-1).dados, { categoria: 'GERAL_MENSAL', anoPA: '2026', mesPA: '07', DataAcolhimentoProposta: 20261030 });
    assert.match(gd.titulo, /DCTFWeb/);
    assert.equal((await call('POST', `/api/escritorio/situacao-fiscal/guias/${pad}`, { tipo: 'DAS', periodo: '7/26' }, t)).status, 400, 'período validado');

    // ---------- aviso ao cliente ----------
    const { lerRelatorio, textoDoPdf } = await import('../src/servicos/situacao-fiscal.js');
    const rel = lerRelatorio(await textoDoPdf(await relatorioPdf(COM_PENDENCIAS)));
    const ins = db.prepare("INSERT INTO situacao_fiscal (empresa_id, status, situacao, resumo_json, total_aberto, qtd_pendencias, solicitada_em, concluida_em) VALUES (?, 'PRONTA', 'PENDENCIAS', ?, ?, ?, ?, datetime('now'))");
    const agora = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const sPad = Number(ins.run(pad, JSON.stringify(rel), rel.totalAberto, rel.qtdPendencias, agora).lastInsertRowid);
    ins.run(alfa, JSON.stringify(rel), rel.totalAberto, rel.qtdPendencias, agora);
    const det = (await call('GET', `/api/escritorio/situacao-fiscal/${sPad}`, undefined, t)).json;
    assert.equal(det.guias.length, 2);
    const itens = det.resumo.secoes.find((s: any) => s.orgao === 'RFB' && s.tipo === 'PENDENCIA').itens;
    assert.deepEqual(itens.map((i: any) => i.guia?.tipo), ['DARF', 'DCTFWEB', 'DARF']);
    const prev = (await call('GET', `/api/escritorio/situacao-fiscal/aviso/${pad}`, undefined, t)).json;
    assert.equal(prev.para, 'padaria@x.com');
    const txt = prev.linhas.join('\n');
    assert.match(txt, /CP-PATRONAL/); assert.match(txt, /SIMPLES\s*NACIONAL: 1 inscrição, 1 ajuizada/); assert.match(txt, /conte com a gente/);
    // só os marcados, só com a opção ligada, uma vez por consulta
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));
    assert.equal((await call('PUT', '/api/escritorio/situacao-fiscal/marcar-aviso', { ids: [pad], avisar: true }, t)).status, 200);
    const { avisarMarcadosAutomaticamente } = await import('../src/servicos/avisos-debitos.js');
    const desde = new Date(Date.now() - 60e3).toISOString().replace('T', ' ').slice(0, 19);
    let r = await avisarMarcadosAutomaticamente(1, desde);
    assert.equal(r.enviados, 1, JSON.stringify(r));
    assert.deepEqual(enviados.map((m) => m.to), ['padaria@x.com'], 'a Alfa não está marcada');
    r = await avisarMarcadosAutomaticamente(1, desde);
    assert.equal(r.enviados, 0, 'a mesma consulta não é avisada de novo');
    const painel = (await call('GET', '/api/escritorio/situacao-fiscal', undefined, t)).json.clientes;
    assert.deepEqual(painel.filter((c: any) => c.avisar_debitos).map((c: any) => c.empresa_id), [pad]);
    // aviso manual
    assert.equal((await call('POST', `/api/escritorio/situacao-fiscal/avisar/${alfa}`, undefined, t)).status, 200);
    assert.equal(enviados.length, 2);
  } finally {
    await app.close();
  }
});
