import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-controle-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0' });

/** Planilha fictícia no formato do "Controle de Entregas" (abas Fiscal, RH, Simples Nacional, Previdenciária). */
function planilha(): Buffer {
  const cel = (ref: string, v: string | number) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const folha = (linhas: (string | number | null)[][]) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas.map((l, i) =>
    `<row r="${i + 1}">${l.map((v, j) => (v == null ? '' : cel(`${String.fromCharCode(65 + j)}${i + 1}`, v))).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const abas: [string, (string | number | null)[][]][] = [
    ['Fiscal', [['Controle ref.10/2026'], ['Empresas', 'Ent', 'S/S', 'Faturamento', 'Alíquota', 'Imposto', 'Data Emissão', null, 'Enviado'], ['Padaria Boa', null, null, null, null, null, null, 'Whatsapp', '-'], ['Alfa Engenharia', null, null, null, null, null, null, 'E-mail', '-'], ['Desconhecida Ltda', null, null, null, null, null, null, 'E-mail', '-']]],
    ['RH', [['Controle DP'], ['Registro', 'Empresas', 'Darf Prev.', 'FGTS'], [53, 'Padaria Boa Ltda', null, null], [8, 'Alfa', null, null]]],
    ['Senha Simples Nacional', [[null, 'Simples Nacional'], [null, 'Empresas', 'CNPJ', 'CPF Resp. ', 'Código', 'Atividade'], [null, 'Padaria', '11.222.333/0001-81', '390.533.447-05', '111.222.333/444', 'Revenda']]],
    ['Senha Previdenciaria', [['SENHA'], [], ['Razão Social', 'CNPJ', 'Senha'], ['ALFA ENGENHARIA', '45.723.174/0001-10', 4572317], ['OUTRA', '99.999.999/0001-91', 123]]],
  ];
  const arquivos: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  abas.forEach(([, l], i) => (arquivos[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(folha(l))));
  return Buffer.from(zipSync(arquivos));
}

test('controle mensal de entregas, senhas dos clientes e importação da planilha', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const base = { regime: 'SIMPLES', cod_municipio: '4202404', uf: 'SC' };
    const pad = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '11222333000181', razao_social: 'Padaria Boa Ltda', tem_funcionarios: true }, t)).json.id;
    const alfa = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45723174000110', razao_social: 'Alfa Engenharia e Projetos Ltda', nome_fantasia: 'Alfa Engenharia' }, t)).json.id;

    // ---------- controle mensal ----------
    let l = (await call('GET', '/api/escritorio/controle?mes=2026-10&area=FISCAL', undefined, t)).json;
    assert.equal(l.length, 2);
    assert.equal((await call('PUT', '/api/escritorio/controle/linha', { empresa_id: pad, competencia: '2026-10', area: 'FISCAL', dados: { entradas: true, faturamento: 10000, imposto: 600, emissao: '2026-11-10' }, canal_envio: 'WHATSAPP' }, t)).status, 200);
    l = (await call('GET', '/api/escritorio/controle?mes=2026-10&area=FISCAL', undefined, t)).json;
    const lp = l.find((x: any) => x.empresa_id === pad);
    assert.deepEqual([lp.dados.faturamento, lp.dados.imposto, lp.dados.entradas, lp.canal_envio, lp.usuario], [10000, 600, true, 'WHATSAPP', 'Ana']);
    // registro do DP fica no cliente; competências são separadas
    await call('PUT', '/api/escritorio/controle/linha', { empresa_id: pad, competencia: '2026-10', area: 'DP', dados: { darf_prev: 1500.5, fgts: 320, sindicato: 0 }, registro_dp: '53' }, t);
    const dp = (await call('GET', '/api/escritorio/controle?mes=2026-10&area=DP', undefined, t)).json.find((x: any) => x.empresa_id === pad);
    assert.deepEqual([dp.dados.darf_prev, dp.registro_dp], [1500.5, '53']);
    assert.deepEqual((await call('GET', '/api/escritorio/controle?mes=2026-11&area=FISCAL', undefined, t)).json.find((x: any) => x.empresa_id === pad).dados, {});
    assert.equal((await call('PUT', '/api/escritorio/controle/linha', { empresa_id: pad, competencia: '2026-10', area: 'FISCAL', dados: { imposto: -5 } }, t)).status, 400);

    // ---------- senhas ----------
    assert.equal((await call('PUT', `/api/escritorio/acessos/${pad}`, { sn_cpf_responsavel: '390.533.447-05', sn_codigo: '123.456.789/012', sn_atividade: 'Revenda', prev_senha: 'abc123' }, t)).status, 200);
    const ac = (await call('GET', '/api/escritorio/acessos', undefined, t)).json.find((x: any) => x.empresa_id === pad);
    assert.deepEqual([ac.tem_codigo, ac.tem_prev, ac.sn_cpf_responsavel], [true, true, '39053344705']);
    assert.ok(!JSON.stringify(ac).includes('123.456.789/012'), 'a lista não traz segredos');
    const bruto = db.prepare('SELECT sn_codigo_enc FROM acessos_cliente WHERE empresa_id = ?').get(pad) as any;
    assert.ok(!bruto.sn_codigo_enc.includes('123.456'), 'guardado criptografado');
    assert.deepEqual((await call('POST', `/api/escritorio/acessos/${pad}/revelar`, undefined, t)).json, { sn_codigo: '123.456.789/012', prev_senha: 'abc123' });
    // trocar só a atividade mantém o código
    await call('PUT', `/api/escritorio/acessos/${pad}`, { sn_cpf_responsavel: '39053344705', sn_atividade: 'Indústria' }, t);
    assert.equal((await call('POST', `/api/escritorio/acessos/${pad}/revelar`, undefined, t)).json.sn_codigo, '123.456.789/012');
    // usuário comum (sem a permissão "senhas") não vê
    await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', senha: 'senha-segura-2', tipo: 'normal' }, t);
    db.prepare("UPDATE usuarios SET trocar_senha = 0, permissoes = NULL WHERE login = 'JOAO'").run();
    const tj = (await call('POST', '/api/login', { usuario: 'joao', senha: 'senha-segura-2' })).json.token;
    assert.equal((await call('POST', `/api/escritorio/acessos/${pad}/revelar`, undefined, tj)).status, 403);
    assert.equal((await call('GET', '/api/escritorio/controle?mes=2026-10&area=FISCAL', undefined, tj)).status, 200);

    // ---------- planilha ----------
    const b64 = planilha().toString('base64');
    const an = (await call('POST', '/api/escritorio/controle/planilha/analisar', { base64: b64 }, t)).json;
    assert.deepEqual(an.resumo, { SIMPLES: { total: 1, ligados: 1 }, PREVIDENCIA: { total: 2, ligados: 1 }, CANAL: { total: 3, ligados: 2 }, REGISTRO: { total: 2, ligados: 2 } });
    assert.ok(!JSON.stringify(an).includes('111.222.333/444'), 'a prévia não traz senhas');
    const itens = an.itens.filter((i: any) => i.empresa_id).map((i: any) => `${i.tipo}:${i.linha}`);
    assert.equal((await call('POST', '/api/escritorio/controle/planilha/importar', { base64: b64, itens }, t)).json.importados, 6);
    assert.equal((await call('POST', `/api/escritorio/acessos/${pad}/revelar`, undefined, t)).json.sn_codigo, '111.222.333/444');
    assert.equal((await call('POST', `/api/escritorio/acessos/${alfa}/revelar`, undefined, t)).json.prev_senha, '4572317');
    const ea = db.prepare('SELECT canal_envio, registro_dp FROM empresas WHERE id = ?').get(alfa) as any;
    assert.deepEqual([ea.canal_envio, ea.registro_dp], ['EMAIL', '8']);
  } finally { await app.close(); }
});
