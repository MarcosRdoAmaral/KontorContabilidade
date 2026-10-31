import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-parc-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('parcelamentos do Simples e caixa postal pelo Integra Contador', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const P = await import('../src/servicos/parcelamentos-caixa.js');
  const { monitorFiscal } = await import('../src/servicos/monitor.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => (await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: '06990590000123', razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t);
    const a = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES' }, t)).id;
    const pedidos: string[] = [];
    const ok = (dados: any) => ({ status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify(dados) } });
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any, _t: any, endpoint: string) {
        const { idSistema, idServico, dados } = corpo.pedidoDados;
        pedidos.push(`${idSistema}/${idServico}/${endpoint}`);
        if (idServico === 'PEDIDOSPARC163') return ok({ parcelamentos: [{ numero: 1, dataDoPedido: 20200110, situacao: 'Encerrado por rescisão', dataDaSituacao: 20210101 }, { numero: 2, dataDoPedido: 20240301, situacao: 'Em parcelamento', dataDaSituacao: 20240301 }] });
        if (idServico === 'PARCELASPARAGERAR162') return ok({ listaParcelas: [{ parcela: 202401, valor: 310.5 }, { parcela: 209912, valor: 300 }] });
        if (idServico === 'PEDIDOSPARC173') return { status: 400, corpo: { status: 400, mensagens: [{ codigo: 'AcessoNegado-PARCSN-ESP', texto: 'Não há procuração para o serviço' }], dados: '' } };
        if (idServico.startsWith('PEDIDOSPARC')) return { status: 404, corpo: { status: 404, mensagens: [{ codigo: 'x', texto: 'Não foram encontrados parcelamentos para o contribuinte.' }], dados: '' } };
        if (idServico === 'GERARDAS161') { assert.equal(JSON.parse(dados).parcelaParaEmitir, 202401); assert.equal(endpoint, 'Emitir'); return ok({ docArrecadacaoPdfB64: Buffer.from('%PDF-1.4 x').toString('base64'), valor: 315.2 }); }
        if (idServico === 'MSGCONTRIBUINTE61') {
          assert.equal(JSON.parse(dados).statusLeitura, '0');
          return ok({ codigo: '00', conteudo: [{ quantidadeMensagens: '2', indicadorUltimaPagina: 'S', listaMensagens: [
            { isn: '123', assuntoModelo: 'Intimação ++VARIAVEL++', valorParametroAssunto: 'nº 55', dataEnvio: '20261020', indicadorLeitura: '0', relevancia: '2', descricaoOrigem: 'DRF Florianópolis' },
            { isn: '124', assuntoModelo: 'Aviso', dataEnvio: '20261001', indicadorLeitura: '1', relevancia: '1' }] }] });
        }
        if (idServico === 'MSGDETALHAMENTO62') return ok({ codigo: '00', conteudo: [{ assuntoModelo: 'Intimação ++VARIAVEL++', valorParametroAssunto: 'nº 55', corpoModelo: '<p>Prazo de ++1++ dias</p>', variaveis: ['30'], dataEnvio: '20261020' }] });
        throw new Error('inesperado ' + idServico);
      },
    };
    const r = await P.consultarParcelamentos(1, 1, a, transporte);
    assert.equal(r.situacao, 'EM_ATRASO');
    assert.equal(r.ativos, 1);
    assert.equal(r.atrasadas, 1, 'só a parcela de meses passados');
    assert.match(r.erro!, /especial.*sem procuração/i);
    assert.ok(!pedidos.some((x) => x.includes('MEI')), 'cliente do Simples não consulta os sistemas do MEI');
    const das = await P.emitirDasParcela(1, 1, a, 'PARCSN', '202401', transporte);
    assert.equal(das.valor, 315.2);
    assert.ok(db.prepare('SELECT 1 FROM guias_recalculadas WHERE id = ?').get(das.id));

    const c = await P.consultarCaixaPostal(1, 1, a, transporte);
    assert.deepEqual(c, { situacao: 'OK', nao_lidas: 1, relevantes: 1, erro: null });
    assert.ok(!pedidos.some((x) => x.includes('MSGDETALHAMENTO62')), 'a consulta em lote não abre as mensagens');
    const m = monitorFiscal(1);
    const ca = m.clientes.find((x: any) => x.empresa_id === a)!;
    assert.equal(ca.processos.PARC, 'ATENCAO');
    assert.equal(ca.processos.CAIXA, 'ATENCAO');
    assert.ok(m.notificacoes.some((n) => n.titulo.includes('Intimação nº 55')));

    const msg = await P.abrirMensagem(1, a, '123', transporte);
    assert.equal(msg.texto, 'Prazo de 30 dias');
    assert.equal(msg.assunto, 'Intimação nº 55');
    assert.equal(monitorFiscal(1).clientes.find((x: any) => x.empresa_id === a)!.processos.CAIXA, 'EM_DIA', 'aberta pelo Kontor conta como lida');
  } finally {
    await app.close();
  }
});
