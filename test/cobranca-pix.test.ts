import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc16, lerPix, montarPix } from '../src/cobranca/pix.js';

test('Pix copia e cola: conferência do BR Code', () => {
  assert.equal(crc16('123456789'), '29B1'); // valor de referência do CRC16-CCITT (FFFF)
  const codigo = montarPix({ chave: 'contato@ciclo.com.br', valor: 225, nome: 'CICLO ASSESSORIA', cidade: 'BLUMENAU', txid: 'ABM092026' });
  const p = lerPix(`  ${codigo}\n`);
  assert.deepEqual([p.valor, p.recebedor, p.cidade, p.chave, p.txid], [225, 'CICLO ASSESSORIA', 'BLUMENAU', 'contato@ciclo.com.br', 'ABM092026']);
  assert.throws(() => lerPix('abc'), /000201/);
  assert.throws(() => lerPix(codigo.slice(0, -1)), /incompleto/);
  assert.throws(() => lerPix(codigo.replace('225.00', '226.00')), /dígito de conferência/);
  assert.equal(lerPix(montarPix({ chave: '13269205000119', nome: 'CICLO', cidade: 'BLUMENAU' })).valor, null, 'Pix sem valor fixo');
});

test('carteira Pix: cobrança sem boleto, Pix colado, demonstrativo e e-mail', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-pix-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { cifrarTexto } = await import('../src/cofre.js');
  const E = await import('../src/servicos/email.js');
  const enviados: any[] = [];
  E.trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, corpo: r.rawPayload, tipo: r.headers['content-type'] };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    db.prepare('UPDATE escritorios SET smtp_enc = ? WHERE id = 1').run(cifrarTexto(JSON.stringify({ host: 'x', porta: 587, usuario: 'u', senha: 's', remetente_nome: 'Ciclo', remetente_email: 'ciclo@x.com' })));
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'CICLO ASSESSORIA CONTABIL LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    // conta Ailos configurada: o cliente da carteira boleto ganha boleto; o da carteira Pix, não
    assert.equal((await call('PUT', `/api/empresas/${eid}/conta-bancaria`, { cooperativa_nome: 'Viacredi', agencia: '101', agencia_dv: '5', conta: '903306', conta_dv: '8', convenio: '123', multa_pct: 2, juros_pct_mes: 1 }, t)).status, 200);
    const tomador = (await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CNPJ', documento: '36128844000160', nome: 'ABM TRANSPORTES LTDA.', email: 'abm@x.com', fone: '47999990000',
      cep: '89069-000', cod_municipio: '4202404', logradouro: 'Rua Doutor Pedro Zimmermann', numero: '11956', bairro: 'Itoupava Central', cidade: 'Blumenau', uf: 'SC',
      modo_faturamento: 'BOLETO', forma_cobranca: 'PIX', vencimento_tipo: 'DIA_FIXO', vencimento_valor: 10 }, t));
    assert.equal(tomador.status, 200, JSON.stringify(tomador.json));
    const tid = tomador.json.id;
    const r = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tid, descricao: 'Serviços contábeis', valor: 225, vencimento: '2027-02-10', enviarEmail: true }, t)).json;
    assert.equal(r.cobranca.forma, 'PIX'); assert.equal(r.cobranca.status, 'AGUARDANDO_BANCO'); assert.equal(r.cobranca.nosso_numero, null, 'Pix não gera boleto');
    assert.equal(r.email.status, 'NAO_ENVIADO'); assert.match(r.email.erro, /Pix copia e cola/);
    assert.ok(r.avisos.some((a: string) => /carteira Pix/.test(a)));
    const id = r.cobranca.id;
    assert.equal((await call('GET', `/api/cobrancas/${id}/demonstrativo`, undefined, t)).status, 400, 'sem Pix ainda não há demonstrativo');
    // Pix de outro valor é recusado; o certo é aceito
    const errado = await call('POST', `/api/cobrancas/${id}/pix`, { codigo: montarPix({ chave: 'contato@ciclo.com.br', valor: 250, nome: 'CICLO', cidade: 'BLUMENAU' }) }, t);
    assert.equal(errado.status, 400); assert.match(errado.json.erro ?? errado.json.message, /diferente do valor da cobrança/);
    const codigo = montarPix({ chave: 'contato@ciclo.com.br', valor: 225, nome: 'CICLO', cidade: 'BLUMENAU', txid: 'ABM' });
    const ok = await call('POST', `/api/cobrancas/${id}/pix`, { codigo }, t);
    assert.equal(ok.status, 200); assert.equal(ok.json.status, 'REGISTRADO'); assert.equal(ok.json.pix_lido.recebedor, 'CICLO');
    // demonstrativo
    const pdf = await call('GET', `/api/cobrancas/${id}/demonstrativo`, undefined, t);
    assert.equal(pdf.status, 200); assert.equal(pdf.tipo, 'application/pdf'); assert.equal(pdf.corpo.subarray(0, 4).toString(), '%PDF');
    // e-mail com o modelo Pix e o demonstrativo anexo
    const em = await call('POST', `/api/cobrancas/${id}/email`, {}, t);
    assert.equal(em.status, 200, JSON.stringify(em.json));
    const m = enviados.at(-1);
    assert.match(m.subject, /Cobrança 01\/2027: R\$\s?225,00/);
    assert.ok(m.text.includes(codigo), 'o copia e cola vai no texto');
    assert.deepEqual(m.attachments.map((a: any) => a.contentType), ['application/pdf']);
    assert.match(m.attachments[0].filename, /^Demonstrativo_Cobranca_ABM_TRANSPORTES_LTDA_01-2027\.pdf$/);
    assert.equal((await call('GET', `/api/empresas/${eid}/cobrancas`, undefined, t)).json.find((c: any) => c.id === id).email_status, 'ENVIADO');
    // não entra na remessa do banco e cancela direto
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cobrancas WHERE forma = 'PIX' AND status = 'A_REMETER'").get().n, 0);
    assert.deepEqual((await call('POST', `/api/cobrancas/${id}/cancelar`, {}, t)).json, { baixaNoBanco: false });
    // nova cobrança já com o Pix colado
    const r2 = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tid, descricao: 'Serviços contábeis', valor: 225, vencimento: '2027-03-10', pixCopiaCola: codigo }, t)).json;
    assert.equal(r2.cobranca.status, 'REGISTRADO');
    // rodapé do demonstrativo
    assert.equal((await call('PUT', `/api/empresas/${eid}/demonstrativo`, { rodape: 'Transformando contabilidade em decisões estratégicas' }, t)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${eid}/demonstrativo`, undefined, t)).json.rodape, 'Transformando contabilidade em decisões estratégicas');
    fs.writeFileSync(path.join(os.tmpdir(), 'demonstrativo-teste.pdf'), (await call('GET', `/api/cobrancas/${r2.cobranca.id}/demonstrativo`, undefined, t)).corpo);
  } finally { await app.close(); }
});
