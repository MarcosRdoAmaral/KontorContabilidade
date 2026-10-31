import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-buscar-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

test('busca DCTFWeb e PGDAS-D transmitidos por outro sistema, sem transmitir', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const F = await import('../src/servicos/fechamento.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => (await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).token;
    const base = { cod_municipio: '4202404', uf: 'SC', cliente_desde: '2020-01-01' };
    await call('POST', '/api/escritorio/carteira', { ...base, documento: '06990590000123', razao_social: 'Ciclo', regime: 'SIMPLES', eh_escritorio: true }, t);
    const a = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa', regime: 'SIMPLES', tem_funcionarios: true }, t)).id;
    const pdf = Buffer.from('%PDF-1.4 teste').toString('base64');
    const chamadas: string[] = [];
    let semDeclaracao = false;
    const ok = (dados: any) => ({ status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify(dados) } });
    const transporte = {
      async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
      async consultar(corpo: any) {
        const s = corpo.pedidoDados.idServico; chamadas.push(s);
        if (s === 'CONSRECIBO32') return semDeclaracao ? { status: 404, corpo: { status: 404, mensagens: [{ codigo: 'x', texto: 'Declaração não encontrada' }], dados: '' } } : ok({ PDFByteArrayBase64: pdf });
        if (s === 'GERARGUIA31') return ok({ PDFByteArrayBase64: pdf });
        if (s === 'CONSULTIMADECREC14') { assert.equal(JSON.parse(corpo.pedidoDados.dados).periodoApuracao, '202609'); return ok({ numeroDeclaracao: '45723174202609001', recibo: { nomeArquivo: 'r.pdf', pdf }, declaracao: { nomeArquivo: 'd.pdf', pdf } }); }
        if (s === 'GERARDAS12') return ok([{ pdf }]);
        throw new Error('não devia chamar ' + s);
      },
    };
    const d = await F.transmitirDctfweb(1, 1, a, '2026-09', transporte, true);
    assert.equal(d.jaTransmitida, true);
    assert.equal(d.temGuia, true);
    assert.deepEqual(chamadas, ['CONSRECIBO32', 'GERARGUIA31'], 'não transmite nem assina');
    const p = await F.buscarPgdas(1, 1, a, '2026-09', transporte);
    assert.equal(p.recibo, '45723174202609001');
    assert.equal(p.temGuia, true);
    const fs2 = db.prepare("SELECT tipo, situacao, guia_pdf IS NOT NULL AS g, recibo_pdf IS NOT NULL AS r FROM fechamentos WHERE empresa_id = ? ORDER BY tipo").all(a) as any[];
    assert.deepEqual(fs2.map((x) => [x.tipo, x.situacao, x.g, x.r]), [['DCTFWEB', 'TRANSMITIDA', 1, 1], ['PGDASD', 'TRANSMITIDA', 1, 1]]);
    // busca sem declaração no período: erro, mas não apaga o que já estava guardado
    semDeclaracao = true;
    await assert.rejects(F.transmitirDctfweb(1, 1, a, '2026-09', transporte, true), /recibo|não encontrada/i);
    assert.equal((db.prepare("SELECT situacao FROM fechamentos WHERE empresa_id = ? AND tipo = 'DCTFWEB'").get(a) as any).situacao, 'TRANSMITIDA');
  } finally {
    await app.close();
  }
});

test('DARF: se a Receita falha no cálculo de juros e multa, tenta com o próximo dia útil e guarda o aviso', async () => {
  const F = await import('../src/servicos/fechamento.js');
  const { db } = await import('../src/db.js');
  const a = (db.prepare("SELECT id FROM empresas WHERE razao_social = 'Alfa'").get() as any).id;
  const pdf = Buffer.from('%PDF-1.4 teste').toString('base64');
  const datas: (number | undefined)[] = [];
  let falhaSempre = true;
  const ok = (dados: any) => ({ status: 200, corpo: { status: 200, mensagens: [], dados: JSON.stringify(dados) } });
  const transporte = {
    async autenticar() { return { accessToken: 'a', jwtToken: 'j', expiraEm: Date.now() + 3600e3 }; },
    async consultar(corpo: any) {
      const s = corpo.pedidoDados.idServico;
      if (s === 'CONSRECIBO32') return ok({ PDFByteArrayBase64: pdf });
      if (s === 'GERARGUIA31') {
        const d = JSON.parse(corpo.pedidoDados.dados).DataAcolhimentoProposta; datas.push(d);
        if (falhaSempre || d === undefined) return { status: 500, corpo: { status: 500, mensagens: [{ codigo: 'x', texto: "Exceção inesperada. Houve um erro na etapa 'Cálculo juros e multa.'" }], dados: '' } };
        return ok({ PDFByteArrayBase64: pdf });
      }
      throw new Error('não devia chamar ' + s);
    },
  };
  const r = await F.transmitirDctfweb(1, 1, a, '2026-09', transporte, true);
  assert.equal(datas.length, 2, 'tentou de novo');
  assert.equal(datas[0], undefined); assert.ok(datas[1]! > 20260000);
  assert.match(r.aviso!, /juros e multa/);
  const f = db.prepare("SELECT situacao, guia_pdf IS NOT NULL AS g FROM fechamentos WHERE empresa_id = ? AND tipo = 'DCTFWEB'").get(a) as any;
  assert.deepEqual([f.situacao, f.g], ['TRANSMITIDA', 1], 'mantém o DARF já guardado');
  falhaSempre = false; datas.length = 0;
  const r2 = await F.transmitirDctfweb(1, 1, a, '2026-09', transporte, true, '2026-11-05');
  assert.deepEqual(datas, [20261105], 'usa a data escolhida');
  assert.equal(r2.temGuia, true);
});

test('DARF emitido atualiza o DARF Prev. do controle (sem marcar envio); valor lido depois ao abrir o controle', async () => {
  const F = await import('../src/servicos/fechamento.js');
  const { db } = await import('../src/db.js');
  const a = (db.prepare("SELECT id FROM empresas WHERE razao_social = 'Alfa'").get() as any).id;
  const dp = () => JSON.parse((db.prepare("SELECT dados_json FROM controle_mensal WHERE empresa_id = ? AND competencia = '2026-09' AND area = 'DP'").get(a) as any)?.dados_json ?? '{}');
  // guia guardada sem valor (PDF ilegível na hora): ao abrir o controle, o Kontor tenta ler de novo e não inventa valor
  db.prepare("UPDATE fechamentos SET valor = NULL WHERE empresa_id = ? AND tipo = 'DCTFWEB'").run(a);
  await F.sincronizarControle(1, '2026-09');
  assert.equal(dp().darf_prev, undefined);
  // valor conhecido: preenche o DARF Prev. em branco e não marca o envio
  db.prepare("UPDATE fechamentos SET valor = 1234.56 WHERE empresa_id = ? AND tipo = 'DCTFWEB'").run(a);
  await F.sincronizarControle(1, '2026-09');
  assert.equal(dp().darf_prev, 1234.56);
  assert.equal(dp().enviado, undefined);
  const { lancarNoControle } = await import('../src/servicos/controle-mensal.js');
  lancarNoControle(a, '2026-09', 'DP', 'darf_prev', 1300, 1, true);
  assert.equal(dp().darf_prev, 1300, 'DARF emitido de novo (com juros) substitui');
  lancarNoControle(a, '2026-09', 'DP', 'darf_prev', 999, 1);
  assert.equal(dp().darf_prev, 1300, 'sem sobrescrever não mexe');
});
