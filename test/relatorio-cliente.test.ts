import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('relatório consolidado da situação fiscal do cliente (PDF timbrado)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-relcli-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { dadosSituacaoCliente } = await import('../src/servicos/relatorio-cliente.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, corpo: r.rawPayload, tipo: r.headers['content-type'] };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'PADARIA TESTE LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    db.prepare("UPDATE empresas SET regime = 'SIMPLES' WHERE id = ?").run(eid);
    const resumo = { secoes: [
      { titulo: 'Débitos', tipo: 'PENDENCIA', orgao: 'RFB', itens: [
        { tipo: 'DEBITO', receita: 'SN', descricao: 'Simples Nacional', periodo: '05/2026', saldo: 1000 },
        { tipo: 'DEBITO', receita: 'SN', descricao: 'Simples Nacional', periodo: '06/2026', saldo: 500.5 },
        { tipo: 'DEBITO', receita: '1082-01', descricao: 'CP-SEGUR.', periodo: '07/2026', saldo: 300 }] },
      { titulo: 'Inscrições', tipo: 'PENDENCIA', orgao: 'PGFN', itens: [{ tipo: 'INSCRICAO', inscricao: '91 4 26 000001-00', receita: '3551', descricao: 'IRPJ', situacao: 'ATIVA' }] }] };
    db.prepare("INSERT INTO situacao_fiscal (empresa_id, status, situacao, resumo_json, total_aberto, qtd_pendencias, concluida_em) VALUES (?, 'PRONTA', 'PENDENCIAS', ?, 1800.5, 4, datetime('now'))").run(eid, JSON.stringify(resumo));
    db.prepare("INSERT INTO fgts_consultas (empresa_id, situacao, total, qtd_competencias, competencias_json, consultado_em) VALUES (?, 'EM_ABERTO', 200, 1, ?, datetime('now'))").run(eid, JSON.stringify([{ competencia: '09/2026', total: 200 }]));
    const d = dadosSituacaoCliente(1, eid);
    assert.equal(d.totalAberto, 2000.5, 'Receita/PGFN + FGTS');
    assert.deepEqual(d.sf!.tributos.map((x) => [x.nome, x.periodos.length, x.total]), [['Simples Nacional', 2, 1500.5], ['1082-01 CP-SEGUR.', 1, 300]]);
    assert.equal(d.sf!.inscricoes.length, 1);
    const pdf = await call('GET', `/api/escritorio/monitor/${eid}/relatorio`, undefined, t);
    assert.equal(pdf.status, 200); assert.equal(pdf.tipo, 'application/pdf'); assert.equal(pdf.corpo.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', '/api/escritorio/monitor/99999/relatorio', undefined, t)).status >= 400, true);
    // guia do FGTS baixada pelo aplicativo: guardada, lida e lançada no Controle mensal
    const PDFDocument = (await import('pdfkit')).default;
    const guia: Buffer = await new Promise((ok) => { const p = new PDFDocument(); const b: Buffer[] = []; p.on('data', (x) => b.push(x)); p.on('end', () => ok(Buffer.concat(b))); p.text('Guia do FGTS Digital - GFD. Pagar este documento até 20/11/2026. Valor total do documento: 798,10'); p.end(); });
    const sv = await call('POST', `/api/escritorio/fgts/${eid}/documentos`, { tipo: 'GUIA', competencia: '2026-10', nome: 'GFD 10-2026.pdf', base64: guia.toString('base64') }, t);
    assert.equal(sv.status, 200, JSON.stringify(sv.json)); assert.deepEqual([sv.json.valor, sv.json.vencimento], [798.1, '2026-11-20']);
    assert.equal(JSON.parse((db.prepare("SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = '2026-10' AND area = 'DP'").get(eid) as any).dados_json).fgts, 798.1);
    const rc2 = await call('POST', `/api/escritorio/fgts/${eid}/documentos`, { tipo: 'GUIA', recalculo: true, competencia: '2026-10', nome: 'GFD recalculada.pdf', base64: guia.toString('base64').replace(/^/, '') }, t);
    assert.equal(rc2.status, 200);
    assert.equal((await call('GET', `/api/escritorio/fgts/${eid}`, undefined, t)).json.documentos.length, 2);
    assert.equal((await call('GET', `/api/escritorio/fgts/${eid}`, undefined, t)).json.documentos[0].recalculo, 1);
    assert.equal((await call('GET', `/api/escritorio/fgts/${eid}/documentos/${sv.json.id}`, undefined, t)).corpo.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('POST', `/api/escritorio/fgts/${eid}/documentos`, { tipo: 'RECIBO', nome: 'x.pdf', base64: Buffer.alloc(200).toString('base64') }, t)).status, 400, 'só PDF');
    // pendências por cliente (carteira toda ou só os escolhidos)
    db.prepare("UPDATE empresas SET na_carteira = 1, situacao = 'ATIVO', eh_escritorio = 0 WHERE id = ?").run(eid);
    const { dadosPendencias } = await import('../src/servicos/relatorio-pendencias.js');
    const pd = dadosPendencias(1, null);
    const lin = pd.linhas.find((l) => l.empresa_id === eid)!;
    assert.ok(lin, 'cliente com débitos aparece');
    assert.deepEqual([lin.receita, lin.fgts, lin.total, lin.geral], [1800.5, 200, 2000.5, 'ATENCAO']);
    assert.ok(lin.itens.some((n: any) => n.processo === 'SITFIS'));
    assert.equal(dadosPendencias(1, []).linhas.length, 0, 'seleção vazia');
    const pp = await call('GET', `/api/escritorio/monitor/pendencias?ids=${eid}`, undefined, t);
    assert.equal(pp.status, 200); assert.equal(pp.corpo.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', '/api/escritorio/monitor/pendencias?ids=1;drop', undefined, t)).status, 400);
    // relatórios novos (carteira, cidade/UF, cadastro incompleto) e carta de cobrança
    const tid = Number(db.prepare("INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, cidade, uf, cod_municipio) VALUES (?, 'CNPJ', '36128844000160', 'ABM TRANSPORTES', 'Blumenau', 'SC', '4202404')").run(eid).lastInsertRowid);
    const cob = (venc: string, forma: string, status: string) => Number(db.prepare("INSERT INTO cobrancas (empresa_id, tomador_id, descricao, valor, vencimento, status, forma, multa_pct, juros_pct_mes) VALUES (?, ?, 'Honorários', 100, ?, ?, ?, 2, 1)").run(eid, tid, venc, status, forma).lastInsertRowid);
    const c1 = cob('2020-01-10', 'BOLETO', 'REGISTRADO'); cob('2020-02-10', 'PIX', 'AGUARDANDO_BANCO'); cob('2099-01-10', 'PIX', 'REGISTRADO');
    const rel = async (id: string) => (await call('GET', `/api/empresas/${eid}/relatorios/${id}?de=2019-01-01&ate=2099-12-31`, undefined, t)).json;
    const rc = await rel('a-receber-carteira');
    assert.deepEqual(rc.linhas.filter((l: any) => l._subtotal).map((l: any) => l.valor_sub), [100, 200]);
    assert.equal(rc.totais.valor, 300, 'subtotais não entram no total');
    assert.ok(rc.linhas.some((l: any) => /sem Pix/.test(l.situacao)));
    const ci = await rel('cadastro-incompleto');
    assert.match(ci.linhas.find((l: any) => l.cliente === 'ABM TRANSPORTES').falta, /e-mail, telefone, endereço/);
    assert.equal((await rel('faturamento-cidade')).linhas.length, 0);
    const { dadosCartaCobranca } = await import('../src/servicos/carta-cobranca.js');
    const carta = dadosCartaCobranca(eid, tid, '2020-03-10');
    assert.equal(carta.titulos.length, 2);
    assert.deepEqual([carta.titulos[0].multa, carta.titulos[0].juros, carta.titulos[0].atualizado], [2, 2, 104], '2% de multa + 1% ao mês por 60 dias');
    const pdfCarta = await call('GET', `/api/cobrancas/${c1}/carta`, undefined, t);
    assert.equal(pdfCarta.status, 200); assert.equal(pdfCarta.corpo.subarray(0, 4).toString(), '%PDF');
  } finally { await app.close(); }
});
