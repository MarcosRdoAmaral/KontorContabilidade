import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import PDFDocument from 'pdfkit';
import { SignedXml } from 'xml-crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-fech-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 30 -subj "/CN=CICLO ASSESSORIA:06990590000123" 2>/dev/null && openssl pkcs12 -export -inkey ${tmp}/k.pem -in ${tmp}/c.pem -out ${tmp}/t.pfx -passout pass:1234`);

const ESC = '06990590000123', PADARIA = '11222333000181';
const pdf = (linhas: string[]) => new Promise<string>((ok) => { const d = new PDFDocument(); const p: Buffer[] = []; d.on('data', (b) => p.push(b)); d.on('end', () => ok(Buffer.concat(p).toString('base64'))); linhas.forEach((l) => d.text(l)); d.end(); });
const XML = '<?xml version="1.0" encoding="UTF-8"?><Declaracao xmlns="http://www.receita.fazenda.gov.br/dctfweb"><ConteudoDeclaracao id="ID2026090001"><Contribuinte cnpj="11222333000181"/><Valor>1234.56</Valor></ConteudoDeclaracao></Declaracao>';

test('fechamento: DCTFWeb assinada e transmitida, PGDAS-D calculado e transmitido, envio ao cliente', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const enviados: any[] = [];
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, body: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const esc = (await call('POST', '/api/empresas', { documento: ESC, razao_social: 'Ciclo Assessoria', cod_municipio: '4202404', uf: 'SC', op_simp_nac: 3, eh_escritorio: true }, t)).json.id;
    const b = '----x';
    const up = await app.inject({ method: 'POST', url: `/api/empresas/${esc}/certificado`, headers: { authorization: `Bearer ${t}`, 'content-type': `multipart/form-data; boundary=${b}` },
      payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="senha"\r\n\r\n1234\r\n--${b}\r\nContent-Disposition: form-data; name="arquivo"; filename="t.pfx"\r\nContent-Type: application/x-pkcs12\r\n\r\n`), fs.readFileSync(`${tmp}/t.pfx`), Buffer.from(`\r\n--${b}--\r\n`)]) });
    assert.equal(up.statusCode, 200, up.body);
    const pad = (await call('POST', '/api/escritorio/carteira', { documento: PADARIA, razao_social: 'Padaria Boa Ltda', regime: 'SIMPLES', cod_municipio: '4202404', uf: 'SC', tem_funcionarios: true, email: 'padaria@x.com', cliente_desde: '2020-01-01' }, t)).json.id;
    const { gerarTarefas, definirInicioDoControle } = await import('../src/servicos/obrigacoes.js');
    definirInicioDoControle(1, '2026-01-01'); gerarTarefas(1, '2026-10');

    const PDF_RECIBO = await pdf(['Recibo de entrega']);
    const PDF_DARF = await pdf(['Documento de Arrecadação de Receitas Federais', 'Pagar este documento até 20/10/2026', 'Valor Total do Documento 1.234,56']);
    const PDF_DAS = await pdf(['Documento de Arrecadação do Simples Nacional', 'Pagar este documento até 20/10/2026', 'Valor Total do Documento 612,30']);
    const pedidos: any[] = [];
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any, _t: any, endpoint: string) {
        const s = corpo.pedidoDados.idServico, dados = corpo.pedidoDados.dados ? JSON.parse(corpo.pedidoDados.dados) : null;
        pedidos.push({ s, endpoint, dados });
        const ok = (d: any) => ({ status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify(d) } });
        if (s === 'CONSXMLDECLARACAO38') { assert.equal(endpoint, 'Consultar'); return ok({ XMLStringBase64: Buffer.from(XML).toString('base64') }); }
        if (s === 'TRANSDECLARACAO310') {
          assert.equal(endpoint, 'Declarar');
          const assinado = Buffer.from(dados.xmlAssinadoBase64, 'base64').toString('utf8');
          // o XML continua igual ao recebido, só com a assinatura a mais
          assert.equal(assinado.replace(/<Signature[\s\S]*<\/Signature>/, ''), XML);
          const v = new SignedXml({ publicCert: fs.readFileSync(`${tmp}/c.pem`, 'utf8') });
          v.loadSignature(/<Signature[\s\S]*<\/Signature>/.exec(assinado)![0]);
          assert.ok(v.checkSignature(assinado), 'assinatura válida');
          assert.match(assinado, /Reference URI="#ID2026090001"/); assert.match(assinado, /rsa-sha256/);
          return ok({ numeroRecibo: '260900012345' });
        }
        if (s === 'CONSRECIBO32') return ok({ PDFByteArrayBase64: PDF_RECIBO });
        if (s === 'GERARGUIA31') return ok({ PDFByteArrayBase64: PDF_DARF });
        if (s === 'TRANSDECLARACAO11') {
          assert.equal(endpoint, 'Declarar');
          assert.deepEqual(dados.declaracao.estabelecimentos[0].atividades, [{ idAtividade: 1, valorAtividade: 8000, receitasAtividade: [{ valor: 8000 }] }, { idAtividade: 14, valorAtividade: 2000, receitasAtividade: [{ valor: 2000 }] }]);
          assert.equal(dados.declaracao.receitaPaCompetenciaInterno, 10000);
          const vd = [{ codigoTributo: 1001, valor: 55.2 }, { codigoTributo: 1006, valor: 300.1 }, { codigoTributo: 1007, valor: 257 }];
          if (!dados.indicadorTransmissao) return ok([{ valoresDevidos: vd }]);
          assert.deepEqual(dados.valoresParaComparacao, vd); assert.equal(dados.indicadorComparacao, true);
          return ok([{ idDeclaracao: '11222333202609001', dataHoraTransmissao: '20261030120000', valoresDevidos: vd, declaracao: PDF_RECIBO, recibo: PDF_RECIBO, notificacaoMaed: null }]);
        }
        if (s === 'GERARDAS12') { assert.deepEqual(dados, { periodoApuracao: '202609' }); return ok([{ pdf: PDF_DAS, detalhamento: {} }]); }
        throw new Error(s);
      },
    };
    const { transmitirDctfweb, calcularPgdas, transmitirPgdas } = await import('../src/servicos/fechamento.js');

    // ---------- DCTFWeb ----------
    // o Kontor só transmite a DCTFWeb sem movimento: sem marcar "Sem folha", recusa sem falar com a Receita
    await assert.rejects(transmitirDctfweb(1, 1, pad, '2026-09', transporte as any), /sem movimento/);
    db.prepare("INSERT INTO controle_mensal (empresa_id, competencia, area, dados_json) VALUES (?, '2026-09', 'DP', '{\"sem_folha\":true}')").run(pad);
    const r = await transmitirDctfweb(1, 1, pad, '2026-09', transporte as any);
    assert.deepEqual([r.jaTransmitida, r.recibo, r.valor, r.vencimento, r.temGuia], [false, '260900012345', 1234.56, '2026-10-20', true]);
    const tarefa = db.prepare(`SELECT t.status, t.protocolo FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id WHERE t.empresa_id = ? AND o.codigo = 'DCTFWEB' AND t.competencia = '2026-09'`).get(pad) as any;
    assert.deepEqual([tarefa.status, tarefa.protocolo], ['ENTREGUE', '260900012345']);
    const dp = (await call('GET', '/api/escritorio/controle?mes=2026-09&area=DP', undefined, t)).json.find((x: any) => x.empresa_id === pad);
    assert.equal(dp.dados.darf_prev, 1234.56, 'valor do DARF vai para o Controle mensal');
    assert.equal((await call('GET', `/api/escritorio/fechamento/${pad}/arquivo?mes=2026-09&tipo=DCTFWEB&qual=guia`, undefined, t)).status, 200);

    // ---------- PGDAS-D ----------
    await call('PUT', `/api/escritorio/fechamento/${pad}/atividades`, { ids: [1, 14] }, t);
    const entrada = { receitas: [{ idAtividade: 1, valor: 8000 }, { idAtividade: 14, valor: 2000 }], retificadora: false };
    await assert.rejects(transmitirPgdas(1, 1, pad, '2026-09', entrada, transporte as any), /Calcule/);
    const c = await calcularPgdas(1, 1, pad, '2026-09', entrada, transporte as any);
    assert.equal(c.total, 612.3);
    const tp = await transmitirPgdas(1, 1, pad, '2026-09', entrada, transporte as any);
    assert.deepEqual([tp.recibo, tp.valor, tp.vencimento, tp.temGuia], ['11222333202609001', 612.3, '2026-10-20', true]);
    const fis = (await call('GET', '/api/escritorio/controle?mes=2026-09&area=FISCAL', undefined, t)).json.find((x: any) => x.empresa_id === pad);
    assert.deepEqual([fis.dados.faturamento, fis.dados.imposto], [10000, 612.3]);
    const f = (await call('GET', `/api/escritorio/fechamento/${pad}?mes=2026-09`, undefined, t)).json;
    assert.deepEqual([f.PGDASD.situacao, f.DCTFWEB.situacao, f.atividades], ['TRANSMITIDA', 'TRANSMITIDA', [1, 14]]);
    assert.ok(f.mensagem.some((l: string) => /DAS — Simples Nacional: R\$\s?612,30/.test(l)));

    // ---------- envio ao cliente ----------
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));
    const env = await call('POST', `/api/escritorio/fechamento/${pad}/enviar`, { mes: '2026-09', canal: 'EMAIL' }, t);
    assert.equal(env.status, 200, JSON.stringify(env.json));
    assert.equal(enviados.length, 1); assert.equal(enviados[0].attachments.length, 2); assert.equal(enviados[0].to, 'padaria@x.com');
    const fis2 = (await call('GET', '/api/escritorio/controle?mes=2026-09&area=FISCAL', undefined, t)).json.find((x: any) => x.empresa_id === pad);
    assert.ok(fis2.dados.enviado, 'envio registrado no Controle mensal');
    const res = (await call('GET', '/api/escritorio/fechamento?mes=2026-09', undefined, t)).json.resumo;
    assert.ok(res[pad].enviado_em); assert.equal(res[pad].PGDASD.situacao, 'TRANSMITIDA');
  } finally { await app.close(); }
});
