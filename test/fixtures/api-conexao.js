// Cópia da API de conexão (repositório kontor-site, src/conexao.js) para os testes rodarem a API de verdade, em memória.
// ---------------------------------------------------------------------------
// API de conexão entre o Kontor Gestão Contabilidade (escritório) e o Kontor Gestão Empresas (cliente).
// Fica em /api/conexao/v1 e só repassa mensagens: o conteúdo chega criptografado de ponta a ponta
// (X25519 + AES-256-GCM, feito nos aplicativos), o servidor não tem a chave e apaga cada mensagem
// assim que o destinatário confirma o recebimento (ou depois de 30 dias sem entrega).
//
// Quem é quem:
//  - escritório: registra-se uma vez (POST /escritorios) e recebe um token próprio;
//  - convite: o escritório gera um código para o CNPJ de um cliente (vale 7 dias, uso único);
//  - vínculo: o cliente digita o código no Kontor Empresas ou no aplicativo Kontor do celular (POST /parear) e recebe o token do vínculo.
//    Uma empresa pode ter um Kontor Empresas (computador) e vários celulares conectados ao mesmo escritório.
//  - notificações: o celular registra a assinatura Web Push; a cada envio do escritório o servidor manda um "toque"
//    sem conteúdo (o aplicativo busca e decifra a mensagem sozinho). As chaves VAPID são geradas e guardadas no D1.
// Tokens no formato "<id>.<segredo>"; o banco guarda só o SHA-256 do segredo.
// ---------------------------------------------------------------------------

export const PREFIXO = '/api/conexao/v1';
const DIA = 86400e3;
const VALIDADE_CONVITE = 7 * DIA;
const RETENCAO = 30 * DIA;
const MAX_CORPO = 1_500_000; // caracteres base64 por parte (o aplicativo divide envios maiores)
const MAX_PARTES = 400;
const MAX_PENDENTE = 150_000_000; // bytes aguardando entrega por vínculo e sentido
const MAX_LOTE = 8_000_000; // bytes devolvidos por GET /mensagens
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I
const LIMITES = { registrar: [5, 3600e3], parear: [10, 3600e3], convite: [60, 3600e3] };
const TIPOS = /^[A-Z][A-Z0-9_]{1,39}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS escritorios (id INTEGER PRIMARY KEY, segredo TEXT NOT NULL, nome TEXT NOT NULL, cnpj TEXT NOT NULL, chave TEXT NOT NULL, criado_em INTEGER NOT NULL, visto_em INTEGER)`,
  `CREATE TABLE IF NOT EXISTS convites (codigo TEXT PRIMARY KEY, escritorio_id INTEGER NOT NULL, cnpj TEXT NOT NULL, nome TEXT, expira_em INTEGER NOT NULL, usado_em INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ix_convites_esc ON convites(escritorio_id, cnpj)`,
  `CREATE TABLE IF NOT EXISTS vinculos (id INTEGER PRIMARY KEY, escritorio_id INTEGER NOT NULL, cnpj TEXT NOT NULL, nome TEXT, segredo TEXT NOT NULL, chave TEXT NOT NULL, criado_em INTEGER NOT NULL, visto_em INTEGER, revogado_em INTEGER, revogado_por TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_vinculos_esc ON vinculos(escritorio_id, cnpj)`,
  `CREATE TABLE IF NOT EXISTS mensagens (id INTEGER PRIMARY KEY, vinculo_id INTEGER NOT NULL, para TEXT NOT NULL CHECK (para IN ('E','V')), tipo TEXT NOT NULL, grupo TEXT NOT NULL, parte INTEGER NOT NULL, total INTEGER NOT NULL, corpo TEXT NOT NULL, tamanho INTEGER NOT NULL, criado_em INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_mensagens_para ON mensagens(vinculo_id, para, id)`,
  `CREATE TABLE IF NOT EXISTS tentativas (chave TEXT PRIMARY KEY, n INTEGER NOT NULL, desde INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ajustes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
];
/** Colunas acrescentadas depois da primeira versão (o D1 não tem ADD COLUMN IF NOT EXISTS). */
const COLUNAS = [
  ['vinculos', 'tipo', "TEXT NOT NULL DEFAULT 'EMPRESAS'"],
  ['vinculos', 'dispositivo', 'TEXT'],
  ['vinculos', 'push', 'TEXT'],
];
const HOSTS_PUSH = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com|android\.googleapis\.com)$/;

class Falha extends Error {
  constructor(status, erro) { super(erro); this.status = status; }
}

let schemaPronto = null;
async function garantirSchema(db) {
  schemaPronto ??= (async () => {
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    for (const [tabela, coluna, def] of COLUNAS) {
      const cols = (await db.prepare(`PRAGMA table_info(${tabela})`).all()).results.map((c) => c.name);
      if (!cols.includes(coluna)) await db.prepare(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${def}`).run();
    }
  })().catch((e) => { schemaPronto = null; throw e; });
  await schemaPronto;
}
/** Só para os testes: o banco de teste muda a cada caso. */
export function _reiniciar() { schemaPronto = null; }

export async function conexao(request, env, agora = Date.now(), execucao = null) {
  try {
    if (!env.DB) throw new Falha(503, 'Serviço de conexão indisponível.');
    await garantirSchema(env.DB);
    const url = new URL(request.url);
    const rota = url.pathname.slice(PREFIXO.length) || '/';
    const m = request.method;
    const ctx = { request, env, db: env.DB, agora, url, ip: request.headers.get('CF-Connecting-IP') || 'local', depois: (p) => (execucao?.waitUntil ? execucao.waitUntil(p) : p) };

    if (m === 'GET' && rota === '/saude') return json({ ok: true, versao: 2 });
    if (m === 'GET' && rota === '/push/chave') return json({ ok: true, chave: (await vapid(ctx.db)).publica });
    if (m === 'POST' && rota === '/escritorios') return await registrarEscritorio(ctx);
    if (m === 'POST' && rota === '/parear') return await parear(ctx);

    const quem = await autenticar(ctx);
    if (m === 'PUT' && rota === '/escritorios/eu') return await atualizarEscritorio(ctx, quem);
    if (m === 'POST' && rota === '/convites') return await criarConvite(ctx, quem);
    if (m === 'GET' && rota === '/vinculos') return await listarVinculos(ctx, quem);
    if (m === 'GET' && rota === '/vinculo') return await meuVinculo(ctx, quem);
    if (m === 'DELETE' && rota === '/vinculo') return await revogar(ctx, quem, null);
    if (m === 'PUT' && rota === '/vinculo/push') return await assinarPush(ctx, quem);
    if (m === 'DELETE' && rota === '/vinculo/push') return await assinarPush(ctx, quem, true);
    const del = rota.match(/^\/vinculos\/(\d+)$/);
    if (m === 'DELETE' && del) return await revogar(ctx, quem, Number(del[1]));
    if (m === 'POST' && rota === '/mensagens') return await enviar(ctx, quem);
    if (m === 'GET' && rota === '/mensagens') return await receber(ctx, quem);
    if (m === 'POST' && rota === '/mensagens/confirmar') return await confirmar(ctx, quem);
    throw new Falha(404, 'Rota não encontrada.');
  } catch (e) {
    if (e instanceof Falha) return json({ ok: false, erro: e.message }, e.status);
    console.error('conexao:', e && e.stack || e);
    return json({ ok: false, erro: 'Erro interno no serviço de conexão.' }, 500);
  }
}

/** Limpeza diária (cron): mensagens não entregues em 30 dias, convites vencidos e contadores antigos. */
export async function limpar(env, agora = Date.now()) {
  if (!env.DB) return;
  await garantirSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mensagens WHERE criado_em < ?').bind(agora - RETENCAO),
    env.DB.prepare('DELETE FROM convites WHERE expira_em < ? OR usado_em < ?').bind(agora - DIA, agora - VALIDADE_CONVITE),
    env.DB.prepare('DELETE FROM tentativas WHERE desde < ?').bind(agora - DIA),
  ]);
}

// ---- escritório ----

async function registrarEscritorio(ctx) {
  await limitar(ctx, 'registrar');
  const d = await corpoJson(ctx.request, 8_000);
  const nome = texto(d.nome, 160, 'Informe o nome do escritório.');
  const cnpj = documento(d.cnpj);
  const chave = chavePublica(d.chave);
  const { segredo, hash } = await novoSegredo();
  const r = await ctx.db.prepare('INSERT INTO escritorios (segredo, nome, cnpj, chave, criado_em, visto_em) VALUES (?,?,?,?,?,?)')
    .bind(hash, nome, cnpj, chave, ctx.agora, ctx.agora).run();
  const id = r.meta.last_row_id;
  return json({ ok: true, id, token: `E${id}.${segredo}` }, 201);
}

async function atualizarEscritorio(ctx, quem) {
  exigir(quem, 'E');
  const d = await corpoJson(ctx.request, 8_000);
  const nome = d.nome != null ? texto(d.nome, 160, 'Informe o nome do escritório.') : null;
  const chave = d.chave != null ? chavePublica(d.chave) : null;
  await ctx.db.prepare('UPDATE escritorios SET nome = COALESCE(?, nome), chave = COALESCE(?, chave) WHERE id = ?').bind(nome, chave, quem.id).run();
  return json({ ok: true });
}

async function criarConvite(ctx, quem) {
  exigir(quem, 'E');
  await limitar(ctx, 'convite', `E${quem.id}`);
  const d = await corpoJson(ctx.request, 4_000);
  const cnpj = documento(d.cnpj);
  const nome = d.nome == null ? null : texto(d.nome, 160);
  const codigo = novoCodigo();
  const expira = ctx.agora + VALIDADE_CONVITE;
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM convites WHERE escritorio_id = ? AND cnpj = ? AND usado_em IS NULL').bind(quem.id, cnpj),
    ctx.db.prepare('INSERT INTO convites (codigo, escritorio_id, cnpj, nome, expira_em) VALUES (?,?,?,?,?)').bind(await sha256(codigo), quem.id, cnpj, nome, expira),
  ]);
  return json({ ok: true, codigo: `${codigo.slice(0, 5)}-${codigo.slice(5)}`, expira_em: new Date(expira).toISOString() }, 201);
}

async function listarVinculos(ctx, quem) {
  exigir(quem, 'E');
  const { results } = await ctx.db.prepare(`SELECT v.id, v.cnpj, v.nome, v.tipo, v.dispositivo, v.chave, v.criado_em, v.visto_em, v.revogado_em, v.revogado_por, (v.push IS NOT NULL) AS notificacoes,
      (SELECT COUNT(*) FROM mensagens m WHERE m.vinculo_id = v.id AND m.para = 'V') AS pendentes_cliente
    FROM vinculos v WHERE v.escritorio_id = ? ORDER BY v.id`).bind(quem.id).all();
  return json({ ok: true, vinculos: results.map((v) => ({ ...v, notificacoes: !!v.notificacoes, criado_em: iso(v.criado_em), visto_em: iso(v.visto_em), revogado_em: iso(v.revogado_em) })) });
}

// ---- cliente (Kontor Empresas) ----

async function parear(ctx) {
  await limitar(ctx, 'parear');
  const d = await corpoJson(ctx.request, 8_000);
  const codigo = String(d.codigo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (codigo.length !== 10) throw new Falha(422, 'Código de conexão inválido: são 10 letras e números, como ABCDE-12345.');
  const cnpj = documento(d.cnpj);
  const nome = d.nome == null ? null : texto(d.nome, 160);
  const chave = chavePublica(d.chave);
  const tipo = d.tipo === 'APP' ? 'APP' : 'EMPRESAS';
  const dispositivo = d.dispositivo == null ? null : texto(d.dispositivo, 60);
  const conv = await ctx.db.prepare('SELECT * FROM convites WHERE codigo = ?').bind(await sha256(codigo)).first();
  if (!conv || conv.usado_em) throw new Falha(404, 'Código de conexão não encontrado ou já usado. Peça um novo código ao escritório.');
  if (conv.expira_em < ctx.agora) throw new Falha(410, 'Este código de conexão venceu. Peça um novo código ao escritório.');
  if (conv.cnpj !== cnpj) throw new Falha(409, 'Este código foi gerado para outro CNPJ. Confira a empresa selecionada ou peça um novo código ao escritório.');
  const esc = await ctx.db.prepare('SELECT id, nome, cnpj, chave FROM escritorios WHERE id = ?').bind(conv.escritorio_id).first();
  if (!esc) throw new Falha(404, 'Escritório não encontrado.');
  const { segredo, hash } = await novoSegredo();
  // um Kontor Empresas ativo por escritório e CNPJ (conectar de novo substitui o anterior); celulares podem ser vários
  const antigos = tipo === 'APP' ? [] : (await ctx.db.prepare("SELECT id FROM vinculos WHERE escritorio_id = ? AND cnpj = ? AND tipo = 'EMPRESAS' AND revogado_em IS NULL").bind(esc.id, cnpj).all()).results;
  const ops = [ctx.db.prepare('UPDATE convites SET usado_em = ? WHERE codigo = ?').bind(ctx.agora, conv.codigo)];
  for (const a of antigos) {
    ops.push(ctx.db.prepare("UPDATE vinculos SET revogado_em = ?, revogado_por = 'NOVA_CONEXAO' WHERE id = ?").bind(ctx.agora, a.id));
    ops.push(ctx.db.prepare('DELETE FROM mensagens WHERE vinculo_id = ?').bind(a.id));
  }
  ops.push(ctx.db.prepare('INSERT INTO vinculos (escritorio_id, cnpj, nome, segredo, chave, criado_em, visto_em, tipo, dispositivo) VALUES (?,?,?,?,?,?,?,?,?)').bind(esc.id, cnpj, nome ?? conv.nome, hash, chave, ctx.agora, ctx.agora, tipo, dispositivo));
  const res = await ctx.db.batch(ops);
  const id = res[res.length - 1].meta.last_row_id;
  return json({ ok: true, vinculo: id, token: `V${id}.${segredo}`, cnpj, nome: nome ?? conv.nome, escritorio: { nome: esc.nome, cnpj: esc.cnpj, chave: esc.chave } }, 201);
}

async function meuVinculo(ctx, quem) {
  exigir(quem, 'V');
  const esc = await ctx.db.prepare('SELECT nome, cnpj, chave FROM escritorios WHERE id = ?').bind(quem.escritorio_id).first();
  return json({ ok: true, vinculo: quem.id, cnpj: quem.cnpj, nome: quem.nome, tipo: quem.tipo, dispositivo: quem.dispositivo, notificacoes: !!quem.push, escritorio: esc });
}

async function revogar(ctx, quem, id) {
  let v;
  if (quem.tipo === 'V') v = quem;
  else {
    v = await ctx.db.prepare('SELECT * FROM vinculos WHERE id = ? AND escritorio_id = ?').bind(id, quem.id).first();
    if (!v) throw new Falha(404, 'Conexão não encontrada.');
  }
  await ctx.db.batch([
    ctx.db.prepare('UPDATE vinculos SET revogado_em = COALESCE(revogado_em, ?), revogado_por = COALESCE(revogado_por, ?), push = NULL WHERE id = ?').bind(ctx.agora, quem.tipo === 'V' ? 'CLIENTE' : 'ESCRITORIO', v.id),
    ctx.db.prepare('DELETE FROM mensagens WHERE vinculo_id = ?').bind(v.id),
  ]);
  return json({ ok: true });
}

// ---- mensagens ----

async function enviar(ctx, quem) {
  const d = await corpoJson(ctx.request, MAX_CORPO + 4_000);
  let v;
  if (quem.tipo === 'V') v = quem;
  else {
    v = await ctx.db.prepare('SELECT * FROM vinculos WHERE id = ? AND escritorio_id = ?').bind(Number(d.vinculo), quem.id).first();
    if (!v) throw new Falha(404, 'Conexão não encontrada.');
    if (v.revogado_em) throw new Falha(410, 'Este cliente está desconectado.');
  }
  const tipo = String(d.tipo ?? '');
  if (!TIPOS.test(tipo)) throw new Falha(422, 'Tipo de mensagem inválido.');
  const grupo = String(d.grupo ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(grupo)) throw new Falha(422, 'Identificador do envio inválido.');
  const total = Number(d.total), parte = Number(d.parte);
  if (!Number.isInteger(total) || total < 1 || total > MAX_PARTES || !Number.isInteger(parte) || parte < 1 || parte > total) throw new Falha(422, 'Parte do envio inválida.');
  const corpo = String(d.corpo ?? '');
  if (!corpo || corpo.length > MAX_CORPO || !/^[A-Za-z0-9_-]+$/.test(corpo)) throw new Falha(422, 'Conteúdo da mensagem inválido.');
  const para = quem.tipo === 'V' ? 'E' : 'V';
  const pend = await ctx.db.prepare('SELECT COALESCE(SUM(tamanho), 0) AS t FROM mensagens WHERE vinculo_id = ? AND para = ?').bind(v.id, para).first();
  if (pend.t + corpo.length > MAX_PENDENTE) throw new Falha(507, 'Há envios demais aguardando o outro lado buscar. Tente de novo mais tarde.');
  // a mesma parte do mesmo envio não entra duas vezes (reenvio depois de uma falha de rede)
  const ja = await ctx.db.prepare('SELECT id FROM mensagens WHERE vinculo_id = ? AND para = ? AND grupo = ? AND parte = ?').bind(v.id, para, grupo, parte).first();
  if (ja) return json({ ok: true, id: ja.id, repetida: true });
  const r = await ctx.db.prepare('INSERT INTO mensagens (vinculo_id, para, tipo, grupo, parte, total, corpo, tamanho, criado_em) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(v.id, para, tipo, grupo, parte, total, corpo, corpo.length, ctx.agora).run();
  // envio completo para um celular: avisa por notificação (sem conteúdo; o aplicativo busca e decifra)
  if (para === 'V' && parte === total && v.push) ctx.depois(notificar(ctx, v).catch((e) => console.error('push:', e && e.message)));
  return json({ ok: true, id: r.meta.last_row_id }, 201);
}

async function receber(ctx, quem) {
  const sql = quem.tipo === 'V'
    ? ctx.db.prepare("SELECT id, vinculo_id, tipo, grupo, parte, total, tamanho, criado_em FROM mensagens WHERE vinculo_id = ? AND para = 'V' ORDER BY id LIMIT 200").bind(quem.id)
    : ctx.db.prepare(`SELECT m.id, m.vinculo_id, m.tipo, m.grupo, m.parte, m.total, m.tamanho, m.criado_em FROM mensagens m JOIN vinculos v ON v.id = m.vinculo_id
        WHERE v.escritorio_id = ? AND v.revogado_em IS NULL AND m.para = 'E' ORDER BY m.id LIMIT 200`).bind(quem.id);
  const lista = (await sql.all()).results;
  const escolhidas = [];
  let soma = 0;
  for (const x of lista) {
    if (escolhidas.length && soma + x.tamanho > MAX_LOTE) break;
    escolhidas.push(x.id); soma += x.tamanho;
  }
  if (!escolhidas.length) return json({ ok: true, mensagens: [], restantes: 0 });
  const corpos = (await ctx.db.prepare(`SELECT id, corpo FROM mensagens WHERE id IN (${escolhidas.map(() => '?').join(',')})`).bind(...escolhidas).all()).results;
  const porId = new Map(corpos.map((c) => [c.id, c.corpo]));
  const mensagens = lista.filter((x) => porId.has(x.id)).map((x) => ({
    id: x.id, vinculo: x.vinculo_id, tipo: x.tipo, grupo: x.grupo, parte: x.parte, total: x.total, corpo: porId.get(x.id), criado_em: iso(x.criado_em),
  }));
  return json({ ok: true, mensagens, restantes: lista.length - mensagens.length });
}

async function confirmar(ctx, quem) {
  const d = await corpoJson(ctx.request, 40_000);
  const ids = Array.isArray(d.ids) ? d.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
  if (!ids.length) return json({ ok: true, apagadas: 0 });
  const marcas = ids.map(() => '?').join(',');
  const r = quem.tipo === 'V'
    ? await ctx.db.prepare(`DELETE FROM mensagens WHERE vinculo_id = ? AND para = 'V' AND id IN (${marcas})`).bind(quem.id, ...ids).run()
    : await ctx.db.prepare(`DELETE FROM mensagens WHERE para = 'E' AND id IN (${marcas}) AND vinculo_id IN (SELECT id FROM vinculos WHERE escritorio_id = ?)`).bind(...ids, quem.id).run();
  return json({ ok: true, apagadas: r.meta.changes ?? 0 });
}

// ---- notificações (Web Push, sem conteúdo) ----

async function assinarPush(ctx, quem, remover = false) {
  exigir(quem, 'V');
  if (remover) {
    await ctx.db.prepare('UPDATE vinculos SET push = NULL WHERE id = ?').bind(quem.id).run();
    return json({ ok: true });
  }
  const d = await corpoJson(ctx.request, 4_000);
  let u;
  try { u = new URL(String(d.endpoint ?? '')); } catch { throw new Falha(422, 'Assinatura de notificação inválida.'); }
  if (u.protocol !== 'https:' || !HOSTS_PUSH.test(u.hostname)) throw new Falha(422, 'Serviço de notificação não reconhecido.');
  await ctx.db.prepare('UPDATE vinculos SET push = ? WHERE id = ?').bind(u.href, quem.id).run();
  return json({ ok: true });
}

/** Par de chaves VAPID do servidor (gerado uma vez e guardado no D1). */
let vapidCache = null;
async function vapid(db) {
  if (vapidCache) return vapidCache;
  let linha = await db.prepare("SELECT valor FROM ajustes WHERE chave = 'vapid'").first();
  if (!linha) {
    const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const privada = await crypto.subtle.exportKey('jwk', par.privateKey);
    const publica = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey)));
    await db.prepare("INSERT OR IGNORE INTO ajustes (chave, valor) VALUES ('vapid', ?)").bind(JSON.stringify({ privada, publica })).run();
    linha = await db.prepare("SELECT valor FROM ajustes WHERE chave = 'vapid'").first();
  }
  const v = JSON.parse(linha.valor);
  vapidCache = { publica: v.publica, privada: await crypto.subtle.importKey('jwk', v.privada, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return vapidCache;
}
/** Só para os testes. */
export function _vapid(v) { vapidCache = v; }

async function notificar(ctx, v) {
  const alvo = new URL(v.push);
  const chaves = await vapid(ctx.db);
  const cab = b64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64u(new TextEncoder().encode(JSON.stringify({ aud: alvo.origin, exp: Math.floor(ctx.agora / 1000) + 12 * 3600, sub: 'mailto:contato@kontorgestao.com.br' })));
  const ass = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chaves.privada, new TextEncoder().encode(`${cab}.${corpo}`)));
  const r = await (ctx.env.FETCH_PUSH ?? fetch)(alvo.href, { method: 'POST', headers: { TTL: '172800', Urgency: 'high', Authorization: `vapid t=${cab}.${corpo}.${b64u(ass)}, k=${chaves.publica}`, 'Content-Length': '0' } });
  // assinatura vencida ou removida pelo navegador: apaga
  if (r.status === 404 || r.status === 410) await ctx.db.prepare('UPDATE vinculos SET push = NULL WHERE id = ? AND push = ?').bind(v.id, v.push).run();
  return r.status;
}

// ---- autenticação e apoio ----

async function autenticar(ctx) {
  const h = ctx.request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer ([EV])(\d+)\.([A-Za-z0-9_-]{20,})$/);
  if (!m) throw new Falha(401, 'Acesso não autorizado.');
  const [, tipo, idTxt, segredo] = m;
  const id = Number(idTxt);
  const tabela = tipo === 'E' ? 'escritorios' : 'vinculos';
  const linha = await ctx.db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).bind(id).first();
  if (!linha || !iguais(linha.segredo, await sha256(segredo))) throw new Falha(401, 'Acesso não autorizado.');
  if (tipo === 'V' && linha.revogado_em) throw new Falha(410, linha.revogado_por === 'CLIENTE' ? 'Esta conexão foi desfeita.' : linha.revogado_por === 'NOVA_CONEXAO' ? 'Esta empresa foi conectada de novo em outro computador.' : 'O escritório desfez esta conexão.');
  if (!linha.visto_em || ctx.agora - linha.visto_em > 60e3) await ctx.db.prepare(`UPDATE ${tabela} SET visto_em = ? WHERE id = ?`).bind(ctx.agora, id).run();
  return { ...linha, tipo };
}
const exigir = (quem, tipo) => { if (quem.tipo !== tipo) throw new Falha(403, 'Operação não permitida para este acesso.'); };

async function limitar(ctx, rota, quem = ctx.ip) {
  const [max, janela] = LIMITES[rota];
  const chave = `${rota}:${quem}`;
  const t = await ctx.db.prepare('SELECT n, desde FROM tentativas WHERE chave = ?').bind(chave).first();
  if (!t || ctx.agora - t.desde > janela) {
    await ctx.db.prepare('INSERT INTO tentativas (chave, n, desde) VALUES (?, 1, ?) ON CONFLICT(chave) DO UPDATE SET n = 1, desde = excluded.desde').bind(chave, ctx.agora).run();
    return;
  }
  if (t.n >= max) throw new Falha(429, 'Muitas tentativas. Aguarde uma hora e tente de novo.');
  await ctx.db.prepare('UPDATE tentativas SET n = n + 1 WHERE chave = ?').bind(chave).run();
}

async function corpoJson(request, max) {
  const tam = Number(request.headers.get('Content-Length') || 0);
  if (tam > max) throw new Falha(413, 'Envio grande demais.');
  const txt = await request.text();
  if (txt.length > max) throw new Falha(413, 'Envio grande demais.');
  try { const d = JSON.parse(txt); if (d && typeof d === 'object') return d; } catch { /* abaixo */ }
  throw new Falha(400, 'Dados inválidos.');
}
function texto(v, max, erro) {
  const s = String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
  if (erro && s.length < 2) throw new Falha(422, erro);
  return s || null;
}
function documento(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 14 && d.length !== 11) throw new Falha(422, 'CNPJ ou CPF inválido.');
  return d;
}
function chavePublica(v) {
  const s = String(v ?? '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) throw new Falha(422, 'Chave de criptografia inválida.');
  return s;
}
function novoCodigo() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}
async function novoSegredo() {
  const segredo = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { segredo, hash: await sha256(segredo) };
}
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function iguais(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function b64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
