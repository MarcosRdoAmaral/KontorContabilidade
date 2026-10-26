import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-esc-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0' });

test('vencimentos: dia fixo com ajuste, último dia útil, N-ésimo dia útil, trimestral e anual', async () => {
  const { vencimento, CATALOGO_PADRAO, Obrigacao } = await import('../src/servicos/obrigacoes.js');
  const o = (cod: string) => Obrigacao.parse(CATALOGO_PADRAO.find((x) => x.codigo === cod));
  assert.equal(vencimento(o('DAS'), '2026-10'), '2026-11-23', '20/11/2026 é feriado (Consciência Negra): o DAS passa para segunda 23');
  assert.equal(vencimento(o('FGTS'), '2026-10'), '2026-11-19', 'FGTS antecipa para quinta 19');
  assert.equal(vencimento(o('DCTFWEB'), '2026-09'), '2026-10-30', 'último dia útil de outubro');
  assert.equal(vencimento(o('EFDCONTRIB'), '2026-08'), '2026-10-15', '10º dia útil de outubro (12/10 é feriado)');
  assert.equal(vencimento(o('FOLHA'), '2026-10'), '2026-11-07', 'salário: 5º dia útil contando o sábado (02/11 é feriado)');
  assert.equal(vencimento({ ...o('FOLHA'), regra: 'DIA_UTIL_N' }, '2026-10'), '2026-11-09', 'sem sábado: segunda 09');
  assert.equal(vencimento(o('IRPJCSLL'), '2026-T3'), '2026-10-30');
  assert.equal(vencimento(o('DEFIS'), '2026'), '2027-03-31');
  assert.equal(vencimento(o('ECD'), '2025'), '2026-06-30');
  assert.equal(vencimento(o('13SAL1'), '2026'), '2026-11-30');
  assert.equal(vencimento(o('13SAL2'), '2026'), '2026-12-18', '20/12/2026 é domingo: antecipa para sexta 18');
  assert.equal(vencimento({ ...o('ISS'), dia: 10 }, '2026-01', '10/02'), '2026-02-09', 'feriado municipal cadastrado na empresa também conta');
});

test('valor por extenso e reajuste', async () => {
  const { valorPorExtenso, reajustePendente, acumulado12Meses } = await import('../src/servicos/honorarios.js');
  assert.equal(valorPorExtenso(1250.5), 'mil duzentos e cinquenta reais e cinquenta centavos');
  assert.equal(valorPorExtenso(1100), 'mil e cem reais');
  assert.equal(valorPorExtenso(2101), 'dois mil cento e um reais');
  assert.equal(valorPorExtenso(1000000), 'um milhão de reais');
  assert.equal(valorPorExtenso(1.01), 'um real e um centavo');
  assert.equal(valorPorExtenso(380), 'trezentos e oitenta reais');

  const c = { status: 'ASSINADO', indice: 'IPCA', inicio: '2025-03-10', mes_reajuste: 3, ultimo_reajuste: null };
  assert.equal(reajustePendente(c, '2026-03-05'), true);
  assert.equal(reajustePendente(c, '2026-04-05'), false, 'fora do mês');
  assert.equal(reajustePendente({ ...c, inicio: '2026-01-10' }, '2026-03-05'), false, 'ainda não fez 12 meses');
  assert.equal(reajustePendente({ ...c, ultimo_reajuste: '2026-03-02' }, '2026-03-05'), false, 'já reajustado');
  assert.equal(reajustePendente({ ...c, ultimo_reajuste: '2025-03-02' }, '2026-03-05'), true);

  let urlPedida = '';
  const falso = async (url: string) => { urlPedida = url; return { ok: true, status: 200, json: async () => Array.from({ length: 12 }, (_, i) => ({ data: `01/${String(i + 1).padStart(2, '0')}/2025`, valor: '0,50' })) }; };
  const r = await acumulado12Meses('IPCA', '2026-01', falso);
  assert.equal(r.percentual, 6.17);
  assert.match(urlPedida, /sgs\.433\/.*dataInicial=01\/01\/2025&dataFinal=31\/12\/2025/);
  await assert.rejects(acumulado12Meses('IPCA', '2026-01', async () => ({ ok: true, status: 200, json: async () => [{ data: '01/01/2025', valor: '1' }] })), /ainda não publicou/);
});

test('escritório: carteira, obrigações, certificados, contratos, honorários e permissões', async () => {
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil Itajaí', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' }, undefined)).json.token;
    const base = { cod_municipio: '4208203', uf: 'SC', cliente_desde: '2020-01-01' };

    // ---------- carteira ----------
    const simples = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '11.222.333/0001-81', razao_social: 'Padaria Boa Ltda', regime: 'SIMPLES', tem_funcionarios: true, email: 'padaria@x.com' }, t)).json.id;
    const presumido = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '45.723.174/0001-10', razao_social: 'Engenharia Alfa Ltda', regime: 'PRESUMIDO' }, t)).json.id;
    const escritorio = (await call('POST', '/api/escritorio/carteira', { ...base, documento: '06.990.590/0001-23', razao_social: 'Contábil Itajaí Ltda', regime: 'SIMPLES', eh_escritorio: true }, t)).json.id;
    assert.equal((await call('POST', '/api/escritorio/carteira', { ...base, documento: '11222333000181', razao_social: 'Duplicada', regime: 'MEI' }, t)).status, 409);
    assert.equal((await call('POST', '/api/escritorio/carteira', { ...base, documento: '11222333000100', razao_social: 'CNPJ errado', regime: 'MEI' }, t)).status, 400);
    const emp = db.prepare('SELECT op_simp_nac, reg_ap_trib_sn FROM empresas WHERE id = ?').get(simples) as any;
    assert.deepEqual([emp.op_simp_nac, emp.reg_ap_trib_sn], [3, 1], 'regime da carteira vale para a emissão de NFS-e');
    const cart = (await call('GET', '/api/escritorio/carteira', undefined, t)).json;
    assert.equal(cart.length, 3); assert.equal(cart[0].id, escritorio, 'o escritório aparece primeiro');

    // ---------- obrigações ----------
    const mes = '2099-11';
    let tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    const codigos = (empId: number) => tar.tarefas.filter((x: any) => x.empresa_id === empId && x.vencimento.startsWith(mes)).map((x: any) => x.codigo).sort();
    assert.deepEqual(codigos(simples), ['13SAL1', 'DAS', 'DCTFWEB', 'ESOCIAL', 'FGTS', 'FOLHA'].sort());
    assert.deepEqual(codigos(presumido), ['EFDCONTRIB', 'IRPJCSLL', 'ISS', 'PISCOFINS'].sort().filter((c) => c !== 'IRPJCSLL'), 'IRPJ do 3º tri vence em outubro, não em novembro');
    assert.equal(codigos(escritorio).length, 0, 'o próprio escritório não gera tarefas');
    // gerar de novo não duplica
    const antes = tar.tarefas.length;
    tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    assert.equal(tar.tarefas.length, antes);
    // dispensa o DAS para a padaria e força a EFD-Reinf
    const obrs = (await call('GET', `/api/escritorio/carteira/${simples}/obrigacoes`, undefined, t)).json;
    const idDe = (c: string) => obrs.find((o: any) => o.codigo === c).obrigacao_id;
    assert.equal((await call('PUT', `/api/escritorio/carteira/${simples}/obrigacoes`, [{ obrigacao_id: idDe('DAS'), excecao: 'DISPENSA' }, { obrigacao_id: idDe('REINF'), excecao: 'FORCA' }], t)).status, 200);
    tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    assert.ok(!codigos(simples).includes('DAS')); assert.ok(codigos(simples).includes('REINF'));
    // andamento
    const fgts = tar.tarefas.find((x: any) => x.empresa_id === simples && x.codigo === 'FGTS');
    assert.equal((await call('PUT', `/api/escritorio/tarefas/${fgts.id}`, { status: 'DISPENSADA' }, t)).status, 400, 'dispensa exige motivo');
    assert.equal((await call('PUT', `/api/escritorio/tarefas/${fgts.id}`, { status: 'ENTREGUE', protocolo: 'GUIA-123' }, t)).status, 200);
    tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    const f2 = tar.tarefas.find((x: any) => x.id === fgts.id);
    assert.equal(f2.prazo, 'ENTREGUE'); assert.equal(f2.protocolo, 'GUIA-123'); assert.equal(f2.entregue_por_nome, 'Ana');
    assert.equal(tar.resumo.entregues, 1);
    // tarefa vencida aparece como atrasada
    const passado = '2020-03';
    assert.equal((await call('GET', `/api/escritorio/tarefas?mes=${passado}`, undefined, t)).json.tarefas.length, 0, 'antes do início do controle não gera');
    const { definirInicioDoControle } = await import('../src/servicos/obrigacoes.js');
    definirInicioDoControle(1, '2020-01-01');
    const tp = (await call('GET', `/api/escritorio/tarefas?mes=${passado}`, undefined, t)).json;
    assert.ok(tp.tarefas.length > 0 && tp.tarefas.every((x: any) => x.prazo === 'ATRASADA'));
    // trocar o regime remove as pendentes que deixaram de valer (as futuras)
    const pr = await call('PUT', `/api/escritorio/carteira/${presumido}`, { ...base, documento: '45.723.174/0001-10', razao_social: 'Engenharia Alfa Ltda', regime: 'SIMPLES' }, t);
    assert.equal(pr.status, 200, JSON.stringify(pr.json));
    tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    assert.ok(!codigos(presumido).includes('PISCOFINS')); assert.ok(codigos(presumido).includes('DAS'));
    assert.ok(tar.tarefas.some((x: any) => x.empresa_id === presumido && x.codigo === 'PISCOFINS' && x.prazo === 'ATRASADA'), 'as de períodos já vencidos ficam no histórico');
    // catálogo editável: mudar o dia recalcula as abertas
    const cat = (await call('GET', '/api/escritorio/obrigacoes', undefined, t)).json;
    const das = cat.find((o: any) => o.codigo === 'DAS');
    await call('PUT', `/api/escritorio/obrigacoes/${das.id}`, { ...das, dia: 25 }, t);
    tar = (await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, t)).json;
    assert.equal(tar.tarefas.find((x: any) => x.empresa_id === presumido && x.codigo === 'DAS').vencimento.slice(8), '25');
    assert.equal((await call('DELETE', `/api/escritorio/obrigacoes/${cat.find((o: any) => o.codigo === 'FGTS').id}`, undefined, t)).status, 400, 'com entrega registrada não exclui');

    // ---------- certificados ----------
    const em5 = new Date(Date.now() - 3 * 3600e3 + 5 * 864e5).toISOString().slice(0, 10);
    const cid = (await call('POST', '/api/escritorio/certificados', { empresa_id: simples, tipo: 'PROCURACAO', titular: 'Padaria Boa (e-CAC)', validade: em5, emissor: 'e-CAC' }, t)).json.id;
    let certs = (await call('GET', '/api/escritorio/certificados', undefined, t)).json;
    assert.equal(certs.certificados[0].situacao, 'VENCE_7'); assert.equal(certs.resumo.vence7, 1);
    await call('POST', `/api/escritorio/certificados/${cid}/renovar`, { validade: '2099-12-31' }, t);
    certs = (await call('GET', '/api/escritorio/certificados', undefined, t)).json;
    assert.equal(certs.resumo.vence7, 0); assert.equal(certs.certificados.length, 2);
    assert.ok(certs.certificados.some((c: any) => c.situacao === 'RENOVADO'));

    // ---------- contratos e honorários ----------
    let cfg = (await call('GET', '/api/escritorio/honorarios/config', undefined, t)).json;
    assert.equal(cfg.escritorio.id, escritorio);
    const sv = (await call('POST', `/api/empresas/${escritorio}/servicos`, { nome: 'Honorários', descricao: 'Honorários contábeis', c_trib_nac: '171901' }, t)).json.id;
    const ct = (await call('POST', '/api/escritorio/contratos', { empresa_id: simples, inicio: '2025-03-01', valor: 1250.5, dia_emissao: 1, dia_vencimento: 10, decimo_terceiro: true, modo_faturamento: 'NOTA_BOLETO' }, t)).json;
    assert.equal(ct.numero, 1);
    // assinar sem o serviço configurado: assina, mas avisa que o faturamento não foi ligado
    let st = (await call('POST', `/api/escritorio/contratos/${ct.id}/status`, { status: 'ASSINADO' }, t)).json;
    assert.match(st.avisos.join(' '), /serviço de honorários/);
    const cf = (await call('PUT', '/api/escritorio/honorarios/config', { servicoId: sv }, t)).json;
    assert.ok(cf.ok);
    const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(ct.id) as any;
    assert.ok(contrato.tomador_id, 'configurar o serviço liga o faturamento dos contratos já assinados');
    const tom = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(contrato.tomador_id) as any;
    assert.equal(tom.empresa_id, escritorio); assert.equal(tom.documento, '11222333000181'); assert.equal(tom.agenda_ativa, 1);
    assert.deepEqual([tom.modo_faturamento, tom.vencimento_tipo, tom.vencimento_valor], ['NOTA_BOLETO', 'DIA_FIXO', 10]);
    const ag = (await call('GET', `/api/empresas/${escritorio}/agenda?mes=2099-01`, undefined, t)).json;
    assert.equal(ag.itens.length, 1); assert.equal(ag.itens[0].valor, 1250.5); assert.equal(ag.itens[0].status, 'AGENDADA');
    // segundo contrato assinado para o mesmo cliente é recusado
    const ct2 = (await call('POST', '/api/escritorio/contratos', { empresa_id: simples, inicio: '2026-01-01', valor: 900 }, t)).json;
    assert.equal((await call('POST', `/api/escritorio/contratos/${ct2.id}/status`, { status: 'ASSINADO' }, t)).status, 400);
    assert.equal((await call('DELETE', `/api/escritorio/contratos/${ct2.id}`, undefined, t)).status, 200);
    // texto e PDF
    const txt = (await call('GET', `/api/escritorio/contratos/${ct.id}/texto`, undefined, t)).json;
    assert.match(txt.texto, /R\$\s?1\.250,50 \(mil duzentos e cinquenta reais e cinquenta centavos\)/);
    assert.match(txt.texto, /Padaria Boa Ltda/); assert.match(txt.texto, /13º honorário/); assert.doesNotMatch(txt.texto, /\{\{/);
    const pdf = await call('GET', `/api/escritorio/contratos/${ct.id}/pdf`, undefined, t);
    assert.equal(pdf.status, 200); assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');
    // reajuste
    const rj = (await call('POST', `/api/escritorio/contratos/${ct.id}/reajuste`, { percentual: 10 }, t)).json;
    assert.equal(rj.valorNovo, 1375.55);
    assert.equal((db.prepare('SELECT valor FROM tomador_servicos WHERE tomador_id = ? AND servico_id = ?').get(tom.id, sv) as any).valor, 1375.55);
    assert.equal((await call('GET', `/api/escritorio/contratos/${ct.id}/reajustes`, undefined, t)).json.length, 1);
    // 13º aparece para emitir
    const d13 = (await call('GET', '/api/escritorio/decimo-terceiro?ano=2099', undefined, t)).json;
    assert.equal(d13.length, 1); assert.equal(d13[0].status, 'PRONTA');
    // anexo assinado
    const fd = `--x\r\nContent-Disposition: form-data; name="arquivo"; filename="assinado.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 teste\r\n--x--\r\n`;
    const up = await app.inject({ method: 'POST', url: `/api/escritorio/contratos/${ct.id}/assinado`, payload: fd, headers: { authorization: `Bearer ${t}`, 'content-type': 'multipart/form-data; boundary=x' } });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal((await call('GET', `/api/escritorio/contratos/${ct.id}/assinado`, undefined, t)).raw.subarray(0, 4).toString(), '%PDF');
    // encerrar desliga a emissão automática
    st = (await call('POST', `/api/escritorio/contratos/${ct.id}/status`, { status: 'ENCERRADO' }, t)).json;
    assert.equal((db.prepare('SELECT agenda_ativa FROM tomadores WHERE id = ?').get(tom.id) as any).agenda_ativa, 0);
    assert.equal((await call('PUT', `/api/escritorio/contratos/${ct.id}`, { empresa_id: simples, inicio: '2025-03-01', valor: 1 }, t)).status, 400);

    // ---------- visão geral, captura e avisos ----------
    const vg = (await call('GET', `/api/escritorio/visao?mes=${mes}`, undefined, t)).json;
    assert.equal(vg.clientes.ativos, 2); assert.ok(vg.tarefas.total > 0); assert.ok(vg.atrasadas.length > 0);
    const cap = (await call('GET', '/api/escritorio/captura', undefined, t)).json;
    assert.equal(cap.length, 3); assert.ok(cap.every((c: any) => !c.pode_consultar), 'sem certificado não consulta');
    const { capturarTodos } = await import('../src/servicos/captura.js');
    db.prepare("UPDATE empresas SET cert_pfx_enc = x'00', cert_validade = '2099-01-01T00:00:00Z' WHERE id = ?").run(simples);
    const rc = await capturarTodos(1, null, async () => ({ novas: 3, resumo: '3 notas novas' }) as any);
    assert.deepEqual([rc.consultados, rc.novas, rc.erros], [1, 3, 0]);
    const { montarResumo } = await import('../src/servicos/avisos.js');
    const linhas = montarResumo(1);
    assert.ok(linhas.some((l) => /ATRASADAS/.test(l)));

    // ---------- permissões ----------
    await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', senha: 'senha-segura-2', tipo: 'normal', permissoes: ['certificados'] }, t);
    db.prepare("UPDATE usuarios SET trocar_senha = 0 WHERE login = 'JOAO'").run();
    const tj = (await call('POST', '/api/login', { usuario: 'joao', senha: 'senha-segura-2' })).json.token;
    assert.equal((await call('GET', '/api/escritorio/certificados', undefined, tj)).status, 200);
    assert.equal((await call('GET', `/api/escritorio/tarefas?mes=${mes}`, undefined, tj)).status, 403);
    assert.equal((await call('GET', '/api/escritorio/contratos', undefined, tj)).status, 403);
    assert.equal((await call('GET', '/api/escritorio/avisos', undefined, tj)).status, 403);
    assert.equal((await call('GET', '/api/escritorio/carteira', undefined, tj)).status, 200, 'lista da carteira serve às telas de certificados');
    assert.equal((await call('POST', '/api/escritorio/carteira', { ...base, documento: '27865757000102', razao_social: 'X', regime: 'MEI' }, tj)).status, 403);
  } finally {
    await app.close();
  }
});
