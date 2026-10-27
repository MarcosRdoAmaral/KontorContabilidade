import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-integra-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0' });

const ESC = '06990590000123', PADARIA = '11222333000181', ALFA = '45723174000110', SEMPROC = '27865757000102';

test('versões dos serviços e aviso de versão descontinuada', async () => {
  const { lerVersoes, textoMsgs } = await import('../src/servicos/integra-contador.js');
  assert.deepEqual(lerVersoes('SITFIS=2.1; pgdasd : 1.0\nlixo'), { SITFIS: '2.1', PGDASD: '1.0' });
  assert.deepEqual(lerVersoes(''), {});
  assert.match(textoMsgs([{ codigo: 'x', texto: 'Requisição inválida. Versão Descontinuada.' }]), /Versões dos serviços/);
});

test('datas da Receita', async () => {
  const { dataDaReceita } = await import('../src/servicos/integra-contador.js');
  assert.equal(dataDaReceita('20261115103000'), '2026-11-15');
  assert.equal(dataDaReceita(20240315), '2024-03-15');
  assert.equal(dataDaReceita('2026-11-15T10:30:00'), '2026-11-15');
  assert.equal(dataDaReceita('15/11/2026 10:30'), '2026-11-15');
  assert.equal(dataDaReceita(''), null);
});

test('Integra Contador: configuração, prévia e conferência das obrigações', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: ESC, razao_social: 'Ciclo Assessoria', regime: 'SIMPLES', eh_escritorio: true }, t);
    for (const [doc, nome] of [[PADARIA, 'Padaria'], [ALFA, 'Alfa'], [SEMPROC, 'Sem Procuração']]) {
      await call('POST', '/api/escritorio/carteira', { ...base, documento: doc, razao_social: nome, regime: 'SIMPLES', tem_funcionarios: true }, t);
    }
    const { definirInicioDoControle } = await import('../src/servicos/obrigacoes.js');
    definirInicioDoControle(1, '2026-01-01');

    // ---------- configuração ----------
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: '' }, t)).status, 400, 'produção exige as chaves');
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: 'chave', consumerSecret: 'segredo' }, t)).status, 200);
    const cfg = (await call('GET', '/api/escritorio/integra/config', undefined, t)).json;
    assert.deepEqual([cfg.configurado, cfg.consumerKey, cfg.temSecret, cfg.ambiente], [true, 'chave', true, 'PRODUCAO']);
    assert.ok(!JSON.stringify(cfg).includes('segredo'), 'o segredo nunca volta para a tela');
    assert.ok(!String((db.prepare("SELECT valor FROM parametros WHERE nome = 'integra_contador:1'").get() as any).valor).includes('segredo'), 'guardado cifrado');
    // trocar a chave sem redigitar o segredo mantém o segredo
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: 'chave2' }, t)).status, 200);
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: 'chave2', versoes: 'qualquer coisa' }, t)).status, 400);
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: 'chave2', versoes: 'SITFIS=2.5' }, t)).status, 200);
    const { Integra } = await import('../src/servicos/integra-contador.js');
    const iv = new Integra(1, {} as any, ESC);
    assert.deepEqual([iv.versao('SITFIS'), iv.versao('PGDASD')], ['2.5', '1.0'], 'ajuste da configuração vale por cima do catálogo');
    assert.equal((await call('PUT', '/api/escritorio/integra/config', { ambiente: 'PRODUCAO', consumerKey: 'chave2', versoes: '' }, t)).status, 200);
    assert.equal(iv.versao('SITFIS'), '2.0');
    // sem certificado do escritório, a autenticação real explica o que falta
    const teste = await call('POST', '/api/escritorio/integra/testar', undefined, t);
    assert.equal(teste.status, 400); assert.match(teste.json.erro, /certificado A1/);

    // ---------- prévia ----------
    const mes = '2026-11';
    const pv = (await call('GET', `/api/escritorio/integra/previa?mes=${mes}`, undefined, t)).json;
    assert.equal(pv.porObrigacao.DAS, 3); assert.equal(pv.porObrigacao.DCTFWEB, 3);
    assert.ok(pv.consultas >= 6 && pv.consultas < pv.tarefas + 1, 'DAS de um ano inteiro sai numa consulta por cliente');

    // ---------- conferência ----------
    let autenticacoes = 0;
    const pedidos: any[] = [];
    const transporte = {
      async autenticar() { autenticacoes++; return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any) {
        pedidos.push(corpo);
        const { idServico } = corpo.pedidoDados, doc = corpo.contribuinte.numero;
        assert.equal(corpo.pedidoDados.versaoSistema, '1.0');
        assert.equal(corpo.contratante.numero, ESC); assert.equal(corpo.autorPedidoDados.numero, ESC);
        if (doc === SEMPROC) return { status: 403, corpo: { status: 403, mensagens: [{ codigo: 'AcessoNegado-PGDASD-001', texto: 'Não há procuração eletrônica para o serviço.' }], dados: '' } };
        if (idServico === 'CONSDECLARACAO13') {
          assert.deepEqual(JSON.parse(corpo.pedidoDados.dados), { anoCalendario: '2026' });
          const periodos = doc === PADARIA ? [{ periodoApuracao: 202610, operacoes: [
            { tipoOperacao: 'Declaração Original', indiceDeclaracao: { numeroDeclaracao: '11222333202610001', dataHoraTransmissao: '20261116093000', malha: '' } },
            { tipoOperacao: 'Geração de DAS', indiceDas: { numeroDas: '07202630000001', dataHoraEmissaoDas: '20261116093100', dasPago: true } },
          ] }] : [];
          return { status: 200, corpo: { status: 200, mensagens: [{ codigo: 'Sucesso-PGDASD', texto: 'Requisição efetuada com sucesso.' }], dados: JSON.stringify({ anoCalendario: 2026, periodos }) } };
        }
        if (idServico === 'CONSRECIBO32') {
          assert.deepEqual(JSON.parse(corpo.pedidoDados.dados), { categoria: 'GERAL_MENSAL', anoPA: '2026', mesPA: '10' });
          if (doc === ALFA) return { status: 200, corpo: { status: 200, mensagens: [{ codigo: 'Sucesso-DCTFWEB', texto: 'ok' }], dados: JSON.stringify({ PDFByteArrayBase64: 'JVBERi0=' }) } };
          return { status: 404, corpo: { status: 404, mensagens: [{ codigo: 'Aviso-DCTFWEB-MG08', texto: 'Não foi encontrada declaração para os parâmetros informados.' }], dados: '' } };
        }
        throw new Error('serviço inesperado ' + idServico);
      },
    };
    const { conferirNaReceita } = await import('../src/servicos/integra-contador.js');
    const r = await conferirNaReceita(1, 1, mes, null, transporte);
    assert.equal(autenticacoes, 1, 'token reaproveitado');
    const das = pedidos.filter((p) => p.pedidoDados.idServico === 'CONSDECLARACAO13');
    assert.equal(das.length, 3, 'uma consulta de PGDAS-D por cliente');
    const tarefa = (doc: string, cod: string) => db.prepare(`SELECT t.* FROM tarefas t JOIN empresas e ON e.id = t.empresa_id JOIN obrigacoes o ON o.id = t.obrigacao_id
      WHERE e.documento = ? AND o.codigo = ? AND substr(t.vencimento,1,7) = ?`).get(doc, cod, mes) as any;
    const tp = tarefa(PADARIA, 'DAS');
    assert.equal(tp.status, 'ENTREGUE'); assert.equal(tp.protocolo, '11222333202610001'); assert.equal(tp.entregue_em, '2026-11-16'); assert.equal(tp.entregue_por, 1);
    assert.match(tp.observacao, /DAS pago/); assert.match(tp.observacao, /Integra Contador/);
    assert.equal(tarefa(ALFA, 'DAS').status, 'PENDENTE', 'sem PGDAS-D do período');
    assert.equal(tarefa(ALFA, 'DCTFWEB').status, 'ENTREGUE');
    assert.equal(tarefa(PADARIA, 'DCTFWEB').status, 'PENDENTE');
    assert.equal(tarefa(SEMPROC, 'DAS').status, 'PENDENTE');
    const porSit = (s: string) => r.resultados.filter((x) => x.situacao === s);
    assert.equal(r.entregues, 2);
    assert.ok(porSit('ERRO').every((x) => /procuração/.test(x.mensagem)) && porSit('ERRO').length >= 1);
    assert.ok(porSit('NAO_ENCONTRADA').some((x) => /Não foi encontrada declaração/.test(x.mensagem)));
    // entregues não são conferidas de novo
    pedidos.length = 0;
    await conferirNaReceita(1, 1, mes, null, transporte);
    assert.ok(!pedidos.some((p) => p.contribuinte.numero === ALFA && p.pedidoDados.idServico === 'CONSRECIBO32'), 'DCTFWeb já entregue não é consultada de novo');
    assert.equal(tarefa(PADARIA, 'DAS').status, 'ENTREGUE');

    // ---------- permissões ----------
    await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', senha: 'senha-segura-2', tipo: 'normal', permissoes: ['obrigacoes'] }, t);
    db.prepare("UPDATE usuarios SET trocar_senha = 0 WHERE login = 'JOAO'").run();
    const tj = (await call('POST', '/api/login', { usuario: 'joao', senha: 'senha-segura-2' })).json.token;
    assert.equal((await call('GET', `/api/escritorio/integra/previa?mes=${mes}`, undefined, tj)).status, 200);
    assert.equal((await call('GET', '/api/escritorio/integra/config', undefined, tj)).status, 403, 'configuração só do administrador');
  } finally {
    await app.close();
  }
});
