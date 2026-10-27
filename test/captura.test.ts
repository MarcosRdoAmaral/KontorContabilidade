import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-cap-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0' });

const CLIENTE = '11222333000181', ESCRITORIO = '06990590000123', OUTRO = '45723174000110';
const z64 = (xml: string) => zlib.gzipSync(Buffer.from(xml)).toString('base64');

const nfse = (chave: string, prest: string, toma: string, valor: string, comp = '2026-10-15') => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}"><xLocEmi>Blumenau</xLocEmi><xLocPrestacao>Blumenau</xLocPrestacao>
<nNFSe>${Number(chave.slice(-6))}</nNFSe><xTribNac>Contabilidade</xTribNac><ambGer>2</ambGer><cStat>100</cStat><dhProc>${comp}T10:00:00-03:00</dhProc><nDFSe>1</nDFSe>
<emit><CNPJ>${prest}</CNPJ><xNome>PRESTADOR ${prest}</xNome></emit><valores><vBC>${valor}</vBC><vISSQN>30.00</vISSQN><vLiq>${valor}</vLiq></valores>
<DPS versao="1.01"><infDPS Id="DPS4202404${prest}00001000000000000001"><tpAmb>1</tpAmb><dhEmi>${comp}T09:59:00-03:00</dhEmi><serie>1</serie><nDPS>1</nDPS><dCompet>${comp}</dCompet>
<prest><CNPJ>${prest}</CNPJ></prest><toma><CNPJ>${toma}</CNPJ><xNome>TOMADOR ${toma}</xNome></toma>
<serv><cServ><cTribNac>171901</cTribNac><xDescServ>Serviço de teste</xDescServ></cServ></serv>
<valores><vServPrest><vServ>${valor}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${toma === CLIENTE ? '2' : '1'}</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
const evCancel = (chave: string) => `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${chave}101101001"><pedRegEvento versao="1.01"><infPedReg Id="PRE${chave}101101001">
<tpAmb>1</tpAmb><chNFSe>${chave}</chNFSe><nPedRegEvento>1</nPedRegEvento><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro</xMotivo></e101101></infPedReg></pedRegEvento></infEvento></evento>`;
const ch50 = (n: number) => '4202404' + '2' + CLIENTE + '00' + String(n).padStart(26, '0');

const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const chNfe = (emit: string, n: number) => `422610${emit}55001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}0`;
const procNFe = (ch: string, dest: string) => `<nfeProc ${NS} versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">
<ide><cUF>42</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>1</serie><nNF>${Number(ch.slice(25, 34))}</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${ch.slice(6, 20)}</CNPJ><xNome>EMITENTE ${ch.slice(6, 20)}</xNome><enderEmit><xMun>Blumenau</xMun><UF>SC</UF></enderEmit></emit>
<dest><CNPJ>${dest}</CNPJ><xNome>DESTINATARIO ${dest}</xNome></dest>
<det nItem="1"><prod><cProd>A1</cProd><xProd>Pão</xProd><NCM>19059090</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>250.00</vUnCom><vProd>250.00</vProd></prod></det>
<total><ICMSTot><vProd>250.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vICMS>0.00</vICMS><vIPI>0.00</vIPI><vNF>250.00</vNF></ICMSTot></total>
</infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${ch}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const cancNfe = (ch: string) => `<resEvento ${NS} versao="1.01"><cOrgao>42</cOrgao><CNPJ>${ch.slice(6, 20)}</CNPJ><chNFe>${ch}</chNFe><dhEvento>2026-10-21T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Cancelamento</xEvento><dhRecbto>x</dhRecbto><nProt>1</nProt></resEvento>`;

test('ADN: leitura das respostas', async () => {
  const { lerRespostaAdn } = await import('../src/nfse/adn.js');
  const r = lerRespostaAdn(200, { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [{ NSU: 7, ChaveAcesso: ch50(1), TipoDocumento: 'NFSE', ArquivoXml: z64('<NFSe/>'), DataHoraGeracao: 'x' }] });
  assert.equal(r.situacao, 'DOCUMENTOS'); assert.equal(r.docs[0].nsu, 7); assert.equal(r.docs[0].xml, '<NFSe/>');
  assert.equal(lerRespostaAdn(200, { statusProcessamento: 'DOCUMENTOS_LOCALIZADOS', loteDFe: [{ nsu: 3, arquivoXml: z64('<a/>'), tipoDocumento: 'evento' }] }).docs[0].tipoDocumento, 'EVENTO', 'campos em minúsculas');
  assert.equal(lerRespostaAdn(404, { StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO' }).situacao, 'NENHUM');
  assert.equal(lerRespostaAdn(429, null).situacao, 'LIMITE');
  const rej = lerRespostaAdn(400, { StatusProcessamento: 'REJEICAO', Erros: [{ Codigo: 'E123', Descricao: 'Certificado não autorizado' }] });
  assert.equal(rej.situacao, 'REJEICAO'); assert.match(rej.erros[0], /E123 - Certificado não autorizado/);
  assert.equal(lerRespostaAdn(500, null).situacao, 'ERRO');
});

test('captura: NFS-e do ADN, NF-e de venda pelo autXML e pacote do mês', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload, body: r.body };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    const cli = (await call('POST', '/api/escritorio/carteira', { ...base, documento: CLIENTE, razao_social: 'Padaria Boa Ltda', regime: 'SIMPLES' }, t)).json.id;
    const esc = (await call('POST', '/api/escritorio/carteira', { ...base, documento: ESCRITORIO, razao_social: 'Ciclo Assessoria Contábil Ltda', regime: 'SIMPLES', eh_escritorio: true }, t)).json.id;

    // ---------- NFS-e pelo Ambiente Nacional ----------
    const { buscarNoAdn, papelNaNota } = await import('../src/servicos/nfse-capturadas.js');
    assert.equal(papelNaNota(CLIENTE, '11222333000262', OUTRO), 'PRESTADOR', 'filial do mesmo CNPJ');
    assert.equal(papelNaNota(CLIENTE, OUTRO, CLIENTE), 'TOMADOR');
    const pedidos: number[] = [];
    const fila = [
      { status: 200, corpo: { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [
        { NSU: 1, ChaveAcesso: ch50(1), TipoDocumento: 'NFSE', ArquivoXml: z64(nfse(ch50(1), CLIENTE, OUTRO, '1000.00')) },
        { NSU: 2, ChaveAcesso: ch50(2), TipoDocumento: 'NFSE', ArquivoXml: z64(nfse(ch50(2), OUTRO, CLIENTE, '400.00')) },
        { NSU: 3, ChaveAcesso: ch50(3), TipoDocumento: 'EVENTO', TipoEvento: 'CANCELAMENTO', ArquivoXml: z64(evCancel(ch50(3))) }, // cancelamento antes da nota
        { NSU: 4, ChaveAcesso: ch50(3), TipoDocumento: 'NFSE', ArquivoXml: z64(nfse(ch50(3), CLIENTE, OUTRO, '50.00')) },
      ] } },
    ];
    const consultar = async (nsu: number) => { pedidos.push(nsu); return fila.shift()!; };
    const r = await buscarNoAdn(cli, { consultar });
    assert.deepEqual(pedidos, [0], 'lote com menos de 50 documentos encerra a fila');
    assert.deepEqual([r.prestadas, r.tomadas, r.cancelamentos], [2, 1, 1]);
    const linhas = db.prepare('SELECT chave, papel, situacao, valor, iss_retido, competencia FROM nfse_capturadas WHERE empresa_id = ? ORDER BY chave').all(cli) as any[];
    assert.deepEqual(linhas.map((l) => [l.papel, l.situacao, l.valor]), [['PRESTADOR', 'AUTORIZADA', 1000], ['TOMADOR', 'AUTORIZADA', 400], ['PRESTADOR', 'CANCELADA', 50]]);
    assert.equal(linhas[1].iss_retido, 1); assert.equal(linhas[0].competencia, '2026-10-15');
    const est = db.prepare('SELECT ult_nsu, proxima_consulta, ultimo_resultado FROM adn_distribuicao WHERE empresa_id = ?').get(cli) as any;
    assert.equal(est.ult_nsu, 4); assert.ok(est.proxima_consulta > new Date().toISOString()); assert.match(est.ultimo_resultado, /2 prestada/);
    // dentro do intervalo não consulta de novo
    const r2 = await buscarNoAdn(cli, { consultar });
    assert.equal(r2.consultou, false); assert.equal(pedidos.length, 1);
    // cancelamento depois da nota
    db.prepare('UPDATE adn_distribuicao SET proxima_consulta = NULL WHERE empresa_id = ?').run(cli);
    fila.push({ status: 200, corpo: { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [{ NSU: 5, ChaveAcesso: ch50(1), TipoDocumento: 'EVENTO', ArquivoXml: z64(evCancel(ch50(1))) }] } });
    await buscarNoAdn(cli, { consultar });
    assert.deepEqual(pedidos, [0, 4], 'continua do último NSU');
    assert.equal((db.prepare('SELECT situacao FROM nfse_capturadas WHERE chave = ?').get(ch50(1)) as any).situacao, 'CANCELADA');
    // rejeição vira erro explicado e fica registrada
    db.prepare('UPDATE adn_distribuicao SET proxima_consulta = NULL WHERE empresa_id = ?').run(cli);
    await assert.rejects(buscarNoAdn(cli, { consultar: async () => ({ status: 400, corpo: { StatusProcessamento: 'REJEICAO', Erros: [{ Codigo: 'E1', Descricao: 'Sem permissão' }] } }) }), /Sem permissão/);
    assert.match((db.prepare('SELECT ultimo_erro FROM adn_distribuicao WHERE empresa_id = ?').get(cli) as any).ultimo_erro, /Sem permissão/);
    // sem certificado e sem conexão de teste: pede o certificado
    await assert.rejects(buscarNoAdn(esc), /certificado A1/);

    // ---------- NF-e de venda pelo autXML (busca da empresa do escritório) ----------
    const { processarDocumento } = await import('../src/servicos/nfe-recebidas.js');
    const venda1 = chNfe(CLIENTE, 101), venda2 = chNfe(CLIENTE, 102), compraEsc = chNfe(OUTRO, 5), foraCarteira = chNfe('27865757000102', 9), cancAntes = chNfe(CLIENTE, 103);
    assert.equal(processarDocumento(esc, { nsu: '1', schema: 'procNFe_v4.00.xsd', tipo: 'procNFe', xml: procNFe(venda1, OUTRO) }), 'saida');
    assert.equal(processarDocumento(esc, { nsu: '2', schema: 'procNFe_v4.00.xsd', tipo: 'procNFe', xml: procNFe(venda2, '39053344705') }), 'saida');
    assert.equal(processarDocumento(esc, { nsu: '3', schema: 'procNFe_v4.00.xsd', tipo: 'procNFe', xml: procNFe(compraEsc, ESCRITORIO) }), 'completa', 'compra do escritório segue o fluxo normal');
    assert.equal(processarDocumento(esc, { nsu: '4', schema: 'procNFe_v4.00.xsd', tipo: 'procNFe', xml: procNFe(foraCarteira, OUTRO) }), 'saida');
    assert.equal(processarDocumento(esc, { nsu: '5', schema: 'resEvento_v1.01.xsd', tipo: 'resEvento', xml: cancNfe(venda2) }), 'saida');
    assert.equal(processarDocumento(esc, { nsu: '6', schema: 'resEvento_v1.01.xsd', tipo: 'resEvento', xml: cancNfe(cancAntes) }), 'saida', 'cancelamento antes da nota, emitente da carteira');
    assert.equal(processarDocumento(cli, { nsu: '7', schema: 'procNFe_v4.00.xsd', tipo: 'procNFe', xml: procNFe(chNfe(OUTRO, 6), CLIENTE) }), 'completa', 'na busca do cliente nada muda');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM nfe_recebidas WHERE empresa_id = ?').get(esc) as any).n, 1);
    assert.deepEqual((db.prepare('SELECT chave, situacao FROM nfe_saidas ORDER BY chave').all() as any[]).map((x) => x.situacao).sort(), ['AUTORIZADA', 'AUTORIZADA', 'CANCELADA', 'CANCELADA']);

    // ---------- tela e pacote ----------
    const st = (await call('GET', '/api/escritorio/captura?mes=2026-10', undefined, t)).json;
    const lc = st.find((x: any) => x.id === cli);
    assert.deepEqual([lc.vendas_mes, lc.nfse_prestadas, lc.nfse_tomadas, lc.nfe_mes], [2, 2, 1, 1]);
    assert.equal(st[0].id, esc, 'o escritório aparece primeiro');
    const ax = (await call('GET', '/api/escritorio/captura/autxml?mes=2026-10', undefined, t)).json;
    assert.equal(ax.escritorio.documento, ESCRITORIO); assert.equal(ax.notasNoMes, 3);
    assert.equal(ax.foraDaCarteira.length, 1); assert.equal(ax.foraDaCarteira[0].emitente_documento, '27865757000102');
    const notas = (await call('GET', `/api/escritorio/captura/${cli}/notas?mes=2026-10`, undefined, t)).json;
    assert.equal(notas.vendas.length, 2); assert.equal(notas.nfse.length, 3);
    const xv = await call('GET', `/api/escritorio/captura/${cli}/xml/${venda1}`, undefined, t);
    assert.equal(xv.status, 200); assert.match(xv.body, /<nfeProc/);
    assert.equal((await call('GET', `/api/escritorio/captura/${esc}/xml/${venda1}`, undefined, t)).status, 404, 'XML de venda só pelo cliente emitente');
    const xs = await call('GET', `/api/escritorio/captura/${cli}/xml/${ch50(2)}`, undefined, t);
    assert.equal(xs.status, 200); assert.match(xs.body, /<NFSe/);
    const pac = await call('GET', `/api/escritorio/captura/${cli}/pacote?mes=2026-10`, undefined, t);
    assert.equal(pac.status, 200);
    const arqs = unzipSync(new Uint8Array(pac.raw));
    const nomes = Object.keys(arqs);
    assert.ok(nomes.includes(`vendas/nfe/NFe_${venda1}.xml`)); assert.ok(nomes.includes('vendas/relatorio-vendas.csv'));
    assert.equal(nomes.filter((n) => n.startsWith('servicos/prestadas/')).length, 2); assert.equal(nomes.filter((n) => n.startsWith('servicos/tomadas/')).length, 1);
    assert.match(strFromU8(arqs['servicos/relatorio-nfse.csv']), /"Tomada";.*"Sim"/);
    assert.ok(nomes.some((n) => n.startsWith('entradas/') || n.includes('sefaz')), 'compras continuam no pacote');
  } finally {
    await app.close();
  }
});
