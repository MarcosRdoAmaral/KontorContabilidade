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
