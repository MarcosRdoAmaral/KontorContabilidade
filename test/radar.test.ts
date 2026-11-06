import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('Radar de Oportunidades: pesquisa (demonstração e cache), CRM, painel, permissões e isolamento', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-radar-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const R = await import('../src/servicos/radar.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    // sem fonte configurada: demonstração identificada
    const cfg = (await call('GET', '/api/radar/config', undefined, t)).json;
    assert.equal(cfg.demonstracao, true);
    const p1 = (await call('POST', '/api/radar/pesquisar', { modo: 'NOVAS', dias: 60, uf: 'SC', municipio: 'Blumenau' }, t));
    assert.equal(p1.status, 200, JSON.stringify(p1.json));
    assert.equal(p1.json.demonstracao, true); assert.equal(p1.json.doCache, false);
    assert.ok(p1.json.empresas.length > 0);
    assert.ok(p1.json.empresas.every((e: any) => e.demonstracao && /DEMONSTRA/.test(e.razao_social) && e.municipio === 'Blumenau' && e.situacao === 'ATIVA'));
    assert.ok(p1.json.empresas.every((e: any) => e.data_abertura >= new Date(Date.now() - 61 * 864e5).toISOString().slice(0, 10)), 'só abertas no período');
    const p2 = (await call('POST', '/api/radar/pesquisar', { modo: 'NOVAS', dias: 60, uf: 'SC', municipio: 'Blumenau' }, t)).json;
    assert.equal(p2.doCache, true, 'mesma pesquisa usa o cache');
    const todas = (await call('POST', '/api/radar/pesquisar', { modo: 'TODAS', limite: 100 }, t)).json;
    assert.equal(todas.total, 64);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_empresas').get().n, 64, 'sem duplicidade');
    const tec = todas.empresas.find((e: any) => e.cnae === '6201501');
    assert.equal(tec.potencial.nivel, 'ALTO'); assert.ok(tec.potencial.motivos.includes('Pode emitir NFS-e'));
    // CRM
    const novo = await call('POST', '/api/radar/leads', { cnpj: tec.cnpj }, t);
    assert.equal(novo.status, 200); assert.equal(novo.json.estagio, 'NOVO');
    assert.equal((await call('POST', '/api/radar/leads', { cnpj: tec.cnpj }, t)).status, 409);
    const lid = novo.json.id;
    const ct = (await call('POST', `/api/radar/leads/${lid}/contatos`, { quando: '2026-11-02T10:00', canal: 'TELEFONE', descricao: 'Ligação de apresentação', proximo_contato: '2026-11-05' }, t)).json;
    assert.equal(ct.estagio, 'PRIMEIRO_CONTATO'); assert.equal(ct.contatos.length, 1); assert.equal(ct.proximo_contato, '2026-11-05');
    assert.equal((await call('PUT', `/api/radar/leads/${lid}`, { estagio: 'NAO_INTERESSADO' }, t)).status, 400, 'perda exige motivo');
    assert.equal((await call('PUT', `/api/radar/leads/${lid}`, { estagio: 'EM_NEGOCIACAO' }, t)).json.estagio, 'EM_NEGOCIACAO');
    const conv = (await call('PUT', `/api/radar/leads/${lid}`, { estagio: 'CONVERTIDO' }, t)).json;
    assert.ok(conv.convertido_em);
    assert.equal((await call('GET', `/api/radar/leads/${lid}/cadastro`, undefined, t)).status, 400, 'demonstração não vai para a carteira');
    const cart = (await call('POST', '/api/radar/pesquisar', { modo: 'CARTEIRA' }, t)).json;
    assert.equal(cart.total, 1); assert.equal(cart.empresas[0].lead.estagio, 'CONVERTIDO');
    const det = (await call('GET', `/api/radar/empresas/${tec.cnpj}`, undefined, t)).json;
    assert.equal(det.lead.contatos.length, 1);
    const pn = (await call('GET', '/api/radar/painel', undefined, t)).json;
    assert.equal(pn.kpis.identificadas, 64); assert.equal(pn.kpis.convertidos, 1); assert.equal(pn.kpis.conversao, 100);
    assert.ok(pn.porMunicipio.length && pn.porCnae.length);
    // auditoria registra tudo
    const aud = (await call('GET', '/api/radar/auditoria', undefined, t)).json.map((a: any) => a.acao);
    for (const a of ['PESQUISA', 'LEAD_NOVO', 'CONTATO', 'ESTAGIO']) assert.ok(aud.includes(a), a);
    // atualização pela fonte: mudanças no cadastro ficam registradas
    const P = await import('../src/radar/provedores.js');
    const demo = P.demonstracao();
    R.trocarProvedorRadar(() => ({ ...demo, id: 'CASA_DOS_DADOS', nome: 'Teste', demonstracao: false, consultar: async (c: string) => ({ ...(await demo.consultar(c))!, situacao: 'BAIXADA', telefone: '4733334444' }) }));
    const at = (await call('POST', `/api/radar/empresas/${tec.cnpj}/atualizar`, undefined, t)).json;
    R.trocarProvedorRadar(null);
    assert.deepEqual(at.mudancas.map((m: any) => m.rotulo), ['Situação cadastral'], 'telefone que faltava é complemento');
    assert.equal(at.empresa.telefone, '4733334444');
    assert.equal(at.empresa.alteracoes.length, 1); assert.equal(at.empresa.situacao, 'BAIXADA');
    // a pesquisa traz só parte do cadastro: completar campos vazios não é alteração, e uma pesquisa depois não apaga o que foi completado
    const cnpjP = '69903724000141';
    R.guardarEmpresa({ cnpj: cnpjP, razao_social: 'ESCRITORIO X', data_abertura: '2026-10-28' } as any, 'CASA_DOS_DADOS', false);
    db.prepare('INSERT INTO radar_vistos (escritorio_id, cnpj) VALUES (1, ?)').run(cnpjP);
    const completo = { cnpj: cnpjP, razao_social: 'ESCRITORIO X', data_abertura: '2026-10-28', uf: 'SC', municipio: 'BLUMENAU', cnae: '6911701', natureza_codigo: '2321', situacao: 'ATIVA',
      porte: 'DEMAIS', telefone: '4732099723', email: 'x@x.adv.br', endereco: { logradouro: 'R DOUTOR PEDRO ZIMMERMANN', numero: '2561', cep: '89066000' } };
    let chamadas = 0;
    R.trocarProvedorRadar(() => ({ ...demo, id: 'CASA_DOS_DADOS', nome: 'Teste', demonstracao: false, consultar: async (c: string) => { chamadas++; return c === cnpjP ? (completo as any) : null; } }));
    const lote = (await call('POST', '/api/radar/empresas/atualizar', { cnpjs: [cnpjP, tec.cnpj] }, t)).json;
    assert.equal(lote.atualizadas, 1); assert.equal(lote.falhas, 1); assert.match(lote.resultados[1].mensagem, /não encontrou/);
    let dp = (await call('GET', `/api/radar/empresas/${cnpjP}`, undefined, t)).json;
    assert.deepEqual(dp.alteracoes, [], 'completar não é alteração');
    assert.equal(dp.municipio, 'BLUMENAU'); assert.equal(dp.endereco.numero, '2561');
    R.guardarEmpresa({ cnpj: cnpjP, razao_social: 'ESCRITORIO X' } as any, 'CASA_DOS_DADOS', false); // nova pesquisa, com menos campos
    dp = (await call('GET', `/api/radar/empresas/${cnpjP}`, undefined, t)).json;
    assert.equal(dp.municipio, 'BLUMENAU'); assert.equal(dp.telefone, '4732099723'); assert.deepEqual(dp.alteracoes, []);
    R.guardarEmpresa({ ...completo, telefone: '4733330000', endereco: { numero: '100' } } as any, 'CASA_DOS_DADOS', false);
    dp = (await call('GET', `/api/radar/empresas/${cnpjP}`, undefined, t)).json;
    assert.deepEqual(dp.alteracoes[0].mudancas.map((m: any) => m.rotulo), ['Telefone', 'Endereço']);
    assert.equal(dp.endereco.logradouro, 'R DOUTOR PEDRO ZIMMERMANN', 'endereço completa, não apaga');
    // histórico antigo com "de vazio para valor" (versão anterior) não aparece
    db.prepare('UPDATE radar_empresas SET alteracoes_json = ? WHERE cnpj = ?').run(JSON.stringify([{ em: '2026-11-02T21:38:03Z', origem: 'CASA_DOS_DADOS', mudancas: [{ campo: 'uf', de: null, para: 'SC' }, { campo: 'endereco', de: {}, para: { numero: '1' } }] }]), cnpjP);
    assert.deepEqual((await call('GET', `/api/radar/empresas/${cnpjP}`, undefined, t)).json.alteracoes, []);
    // saldo/limite: interrompe o lote sem consultar o resto
    chamadas = 0;
    R.trocarProvedorRadar(() => ({ ...demo, id: 'CASA_DOS_DADOS', nome: 'Teste', demonstracao: false, consultar: async () => { chamadas++; throw new P.ErroProvedor('Limite de consultas da Casa dos Dados atingido.', 429); } }));
    const lim = (await call('POST', '/api/radar/empresas/atualizar', { cnpjs: [cnpjP, tec.cnpj] }, t)).json;
    assert.equal(chamadas, 1); assert.match(lim.interrompido, /Limite/); assert.equal(lim.atualizadas, 0);
    assert.equal((await call('POST', '/api/radar/empresas/atualizar', { cnpjs: ['11111111000191'] }, t)).status, 404, 'só empresas do radar do escritório');
    assert.equal((await call('POST', '/api/radar/empresas/atualizar', { cnpjs: Array(26).fill(cnpjP) }, t)).status, 400);
    R.trocarProvedorRadar(null);
    // isolamento: outro escritório não vê a empresa nem o lead
    db.prepare("INSERT INTO escritorios (id, nome) VALUES (2, 'Outro')").run();
    assert.throws(() => R.detalheEmpresa(2, tec.cnpj), /não encontrada/);
    assert.throws(() => R.editarLead(2, 1, lid, { estagio: 'NOVO' }), /Lead não encontrado/);
    assert.equal(R.painelRadar(2).kpis.totalLeads, 0);
    // permissões: usuário sem o módulo radar não acessa; com ele, não mexe na configuração
    const criar = async (login: string, perms: string[]) => {
      const provisoria = (await call('POST', '/api/usuarios', { login, nome: login, email: `${login}@x.com`, tipo: 'normal', permissoes: perms, empresas: [] }, t)).json.senhaProvisoria;
      const l1 = (await call('POST', '/api/login', { usuario: login.toUpperCase(), senha: provisoria })).json;
      await call('PUT', '/api/me/senha', { atual: provisoria, nova: `${login}-nova-123` }, l1.token);
      return (await call('POST', '/api/login', { usuario: login.toUpperCase(), senha: `${login}-nova-123` })).json.token;
    };
    const sem = await criar('joao', ['carteira']), com = await criar('maria', ['radar']);
    assert.equal((await call('GET', '/api/radar/painel', undefined, sem)).status, 403);
    assert.equal((await call('GET', '/api/radar/painel', undefined, com)).status, 200);
    assert.equal((await call('PUT', '/api/radar/config', { provedor: 'DEMONSTRACAO', cacheHoras: 24 }, com)).status, 403);
    assert.equal((await call('PUT', '/api/radar/config', { provedor: 'CASA_DOS_DADOS', cacheHoras: 24 }, t)).status, 400, 'Casa dos Dados exige a chave');
  } finally { await app.close(); }
});

test('Radar: Casa dos Dados (corpo da pesquisa, leitura da resposta e erros)', async () => {
  const P = await import('../src/radar/provedores.js');
  const corpo = P.corpoCasaDosDados({ texto: 'padaria', uf: 'SC', municipio: 'Jaraguá do Sul', aberturaDe: '2026-10-01', cnae: '4721-1/02', situacao: 'ATIVA', porte: 'ME', comTelefone: true }, 2, 25);
  assert.deepEqual(corpo, { limite: 25, pagina: 2, busca_textual: [{ texto: ['padaria'], tipo_busca: 'radical', razao_social: true, nome_fantasia: true, nome_socio: false }],
    uf: ['sc'], municipio: ['jaragua do sul'], data_abertura: { inicio: '2026-10-01' }, codigo_atividade_principal: ['4721102'], situacao_cadastral: ['ATIVA'], porte_empresa: { codigos: ['01'] }, mais_filtros: { com_telefone: true } });
  assert.deepEqual(P.corpoCasaDosDados({ texto: '12.345.678/0001-90' }, 1, 10).cnpj, ['12345678000190']);
  const e = P.deCasaDosDados({ cnpj: '12345678000190', razao_social: 'TESTE LTDA', data_abertura: '2026-10-20', porte_empresa: { codigo: '03', descricao: 'EMPRESA DE PEQUENO PORTE' },
    situacao_cadastral: { situacao_cadastral: 'ATIVA' }, endereco: { uf: 'SC', municipio: 'BLUMENAU', ibge: { codigo_municipio: 4202404 }, tipo_logradouro: 'RUA', logradouro: 'XV DE NOVEMBRO', numero: '10' },
    atividade_principal: { codigo: '6201501', descricao: 'Desenvolvimento de software' }, contato_telefonico: [{ completo: '(47) 3333-4444' }], contato_email: [{ email: 'Contato@Teste.com' }] });
  for (const [sc, esperado] of [[{ situacao_cadastral: 'Ativa' }, 'ATIVA'], ['BAIXADA', 'BAIXADA'], [{ descricao: 'INAPTA' }, 'INAPTA'], [{ codigo: '02', situacao_atual: '02' }, 'ATIVA'], [{ situacao_cadastral: 'ATIVO?' }, null]] as const)
    assert.equal(P.deCasaDosDados({ cnpj: '12345678000190', situacao_cadastral: sc }).situacao, esperado, JSON.stringify(sc));
  assert.deepEqual([e.porte, e.situacao, e.cod_municipio, e.cnae, e.telefone, e.email, e.endereco.logradouro], ['EPP', 'ATIVA', '4202404', '6201501', '4733334444', 'contato@teste.com', 'RUA XV DE NOVEMBRO']);
  const resp = (status: number, corpo: any) => (async () => new Response(JSON.stringify(corpo), { status })) as any;
  await assert.rejects(P.casaDosDados('x', resp(401, {})).pesquisar({}, 1, 10), /chave da Casa dos Dados está incorreta/);
  await assert.rejects(P.casaDosDados('x', resp(403, {})).pesquisar({}, 1, 10), /saldo/);
  await assert.rejects(P.casaDosDados('x', resp(429, {})).pesquisar({}, 1, 10), /Limite/);
  const ok = await P.casaDosDados('x', resp(200, { total: 1, cnpjs: [{ cnpj: '12345678000190', razao_social: 'A' }] })).pesquisar({}, 1, 10);
  assert.equal(ok.total, 1); assert.equal(ok.empresas[0].cnpj, '12345678000190');
  await assert.rejects(P.casaDosDados('x', (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as any).pesquisar({}, 1, 10), /Sem conexão/);
});
