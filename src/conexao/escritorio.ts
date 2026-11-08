// ---------------------------------------------------------------------------
// Conexão com o Kontor Gestão Empresas, lado do escritório.
// - Carteira: gera o código de conexão de um cliente e mostra se ele está conectado;
// - Solicitações: pedidos de guia atualizada feitos pelo cliente; o escritório gera (ou anexa) a guia e envia;
// - Fechamentos recebidos: o pacote do mês (XML/PDF das notas e OFX) enviado pelo Kontor Empresas do cliente.
// Toda troca passa pela API de conexão (kontorgestao.com.br), cifrada de ponta a ponta (ver nucleo.ts).
// ---------------------------------------------------------------------------
import { z } from 'zod';
import { db } from '../db.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { ErroNegocio } from '../servicos/emissao.js';
import { empresaDoEscritorio } from '../servicos/cadastro-unico.js';
import { gerarGuia, type PedidoGuia } from '../servicos/guias.js';
import { dadosDePagamento } from '../servicos/fechamento.js';
import { demonstrativoPdf, obterCobranca, referenciaDa } from '../servicos/cobranca.js';
import { FalhaApi, buscarEnvelopes, chamarApi, chaveSessao, enviarEnvelope, gerarChaves, impressao, type Envelope } from './nucleo.js';

interface Config { escritorio_id: number; api_id: number; token: string; privada: string; publica: string; cnpj: string; nome: string; ultimo_sync: string | null; ultimo_erro: string | null }

const cfg = (escritorioId: number) => db.prepare('SELECT * FROM conexao_escritorio WHERE escritorio_id = ?').get(escritorioId) as Config | undefined;
const token = (c: Config) => decifrarTexto(c.token);

/** Na primeira conexão o escritório se registra na API com a empresa marcada como escritório em Cadastros > Empresas. */
async function garantirRegistro(escritorioId: number): Promise<Config> {
  const ja = cfg(escritorioId);
  const empId = empresaDoEscritorio(escritorioId);
  if (!empId) throw new ErroNegocio('Marque em Cadastros > Empresas qual é a empresa do escritório antes de conectar clientes.');
  const e = db.prepare('SELECT documento, COALESCE(nome_fantasia, razao_social) AS nome FROM empresas WHERE id = ?').get(empId) as { documento: string; nome: string };
  if (ja) {
    if (ja.nome !== e.nome) {
      await chamarApi('PUT', '/escritorios/eu', { nome: e.nome }, token(ja));
      db.prepare('UPDATE conexao_escritorio SET nome = ? WHERE escritorio_id = ?').run(e.nome, escritorioId);
      ja.nome = e.nome;
    }
    return ja;
  }
  const chaves = gerarChaves();
  const r = await chamarApi<{ id: number; token: string }>('POST', '/escritorios', { nome: e.nome, cnpj: e.documento, chave: chaves.publica });
  db.prepare('INSERT INTO conexao_escritorio (escritorio_id, api_id, token, privada, publica, cnpj, nome) VALUES (?,?,?,?,?,?,?)')
    .run(escritorioId, r.id, cifrarTexto(r.token), cifrarTexto(chaves.privada), chaves.publica, e.documento, e.nome);
  return cfg(escritorioId)!;
}

function clienteDaCarteira(escritorioId: number, empresaId: number) {
  const c = db.prepare('SELECT id, documento, COALESCE(nome_fantasia, razao_social) AS nome, eh_escritorio FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
  if (!c) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (c.eh_escritorio) throw new ErroNegocio('A empresa do escritório não se conecta a si mesma.');
  return c as { id: number; documento: string; nome: string };
}

const linhaCliente = (empresaId: number) => db.prepare('SELECT * FROM conexao_clientes WHERE empresa_id = ?').get(empresaId) as any;
const aparelhosAtivos = (empresaId: number) => db.prepare("SELECT * FROM conexao_aparelhos WHERE empresa_id = ? AND situacao = 'CONECTADO' ORDER BY (tipo = 'EMPRESAS') DESC, vinculo").all(empresaId) as any[];
/** Resumo do cliente: conectado se algum aparelho (Kontor Empresas ou celular) estiver conectado. */
function atualizarResumo(empresaId: number) {
  const n = aparelhosAtivos(empresaId).length;
  const l = linhaCliente(empresaId);
  if (!l) return;
  const sit = n ? 'CONECTADO' : l.codigo && l.codigo_expira > new Date().toISOString() ? 'CONVITE' : db.prepare('SELECT 1 FROM conexao_aparelhos WHERE empresa_id = ?').get(empresaId) ? 'DESCONECTADO' : 'CONVITE';
  db.prepare('UPDATE conexao_clientes SET situacao = ? WHERE empresa_id = ?').run(sit, empresaId);
}

/** Situação da conexão de um cliente, para a Carteira: o código em aberto e cada aparelho conectado. */
export function statusConexao(escritorioId: number, empresaId: number) {
  clienteDaCarteira(escritorioId, empresaId);
  const l = linhaCliente(empresaId);
  const c = cfg(escritorioId);
  const codigoValido = l?.codigo && l.codigo_expira > new Date().toISOString();
  const privada = c ? decifrarTexto(c.privada) : null;
  const aparelhos = (db.prepare('SELECT * FROM conexao_aparelhos WHERE empresa_id = ? ORDER BY (situacao = \'CONECTADO\') DESC, vinculo DESC LIMIT 30').all(empresaId) as any[]).map((a) => {
    let cod: string | null = null;
    if (a.situacao === 'CONECTADO' && privada && c) { try { cod = impressao(chaveSessao(privada, a.chave, c.cnpj, l?.cnpj ?? a.cnpj)); } catch { cod = null; } }
    return { vinculo: a.vinculo, tipo: a.tipo as 'EMPRESAS' | 'APP', nome: a.nome, situacao: a.situacao, conectado_em: a.conectado_em, visto_em: a.visto_em, notificacoes: !!a.notificacoes,
      desconectado_em: a.desconectado_em, motivo: a.motivo, impressao: cod };
  });
  const ativos = aparelhos.filter((a) => a.situacao === 'CONECTADO');
  return {
    situacao: (ativos.length ? 'CONECTADO' : l?.situacao === 'CONECTADO' ? 'DESCONECTADO' : l?.situacao ?? 'NAO_CONECTADO') as 'NAO_CONECTADO' | 'CONVITE' | 'CONECTADO' | 'DESCONECTADO',
    codigo: codigoValido ? decifrarTexto(l.codigo) : null, codigo_expira: codigoValido ? l.codigo_expira : null,
    aparelhos, conectados: ativos.length,
    // compatibilidade com a tela da 1.51: dados do primeiro aparelho
    conectado_em: ativos[0]?.conectado_em ?? null, visto_em: ativos[0]?.visto_em ?? null, impressao: ativos[0]?.impressao ?? null,
    desconectado_em: aparelhos[0]?.desconectado_em ?? null, motivo: aparelhos[0]?.motivo ?? null,
    ultimo_sync: c?.ultimo_sync ?? null, ultimo_erro: c?.ultimo_erro ?? null,
  };
}

/** Gera o código de conexão (vale 7 dias, uso único) para o cliente digitar no Kontor Empresas ou no aplicativo do celular. */
export async function convidar(escritorioId: number, empresaId: number) {
  const cli = clienteDaCarteira(escritorioId, empresaId);
  const c = await garantirRegistro(escritorioId);
  const r = await chamarApi<{ codigo: string; expira_em: string }>('POST', '/convites', { cnpj: cli.documento, nome: cli.nome }, token(c));
  db.prepare(`INSERT INTO conexao_clientes (empresa_id, cnpj, situacao, codigo, codigo_expira) VALUES (?,?,'CONVITE',?,?)
    ON CONFLICT(empresa_id) DO UPDATE SET codigo = excluded.codigo, codigo_expira = excluded.codigo_expira`).run(empresaId, cli.documento, cifrarTexto(r.codigo), r.expira_em);
  atualizarResumo(empresaId);
  return statusConexao(escritorioId, empresaId);
}

/** Desconecta um aparelho (ou, sem `vinculo`, todos os aparelhos do cliente). */
export async function desconectar(escritorioId: number, empresaId: number, vinculo?: number) {
  clienteDaCarteira(escritorioId, empresaId);
  const c = cfg(escritorioId);
  const alvos = aparelhosAtivos(empresaId).filter((a) => !vinculo || a.vinculo === vinculo);
  if (vinculo && !alvos.length) throw new ErroNegocio('Aparelho não encontrado.', 404);
  for (const a of alvos) {
    if (c) { try { await chamarApi('DELETE', `/vinculos/${a.vinculo}`, undefined, token(c)); } catch (e) { if (!(e instanceof FalhaApi) || e.http !== 404) throw e; } }
    db.prepare(`UPDATE conexao_aparelhos SET situacao = 'DESCONECTADO', desconectado_em = datetime('now'), motivo = 'Desconectado pelo escritório.' WHERE vinculo = ?`).run(a.vinculo);
  }
  if (!vinculo) db.prepare('UPDATE conexao_clientes SET codigo = NULL, codigo_expira = NULL WHERE empresa_id = ?').run(empresaId);
  atualizarResumo(empresaId);
  return statusConexao(escritorioId, empresaId);
}

// ---- recebimento ----

const Pedido = z.object({
  id: z.string().min(8).max(64),
  tipo: z.enum(['DAS', 'DCTFWEB', 'DARF']),
  periodo: z.string().trim().regex(/^\d{2}\/\d{4}$/),
  data_pagamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  descricao: z.string().trim().max(160).nullish(),
  observacao: z.string().trim().max(1000).nullish(),
  solicitante: z.string().trim().max(120).nullish(),
});
const Fechamento = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nome: z.string().max(200), zip: z.string().max(120_000_000),
  arquivos: z.array(z.string().max(300)).max(20_000).default([]),
  enviado_por: z.string().max(120).nullish(),
});

function tratar(escritorioId: number, env: Envelope) {
  const l = db.prepare('SELECT a.empresa_id, a.nome, a.tipo FROM conexao_aparelhos a JOIN empresas e ON e.id = a.empresa_id WHERE a.vinculo = ? AND e.escritorio_id = ?').get(env.vinculo, escritorioId) as { empresa_id: number; nome: string | null; tipo: string } | undefined;
  if (!l) return; // conexão desfeita neste computador: descarta
  if (env.tipo === 'PEDIDO_GUIA') {
    const p = Pedido.parse(env.dados);
    db.prepare(`INSERT OR IGNORE INTO solicitacoes_guia (empresa_id, origem_id, tipo, periodo, data_pagamento, descricao, observacao, solicitante, criado_em)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(l.empresa_id, p.id, p.tipo, p.periodo, p.data_pagamento ?? null, p.descricao ?? null, p.observacao ?? null,
      [p.solicitante, l.tipo === 'APP' ? 'pelo celular' : null].filter(Boolean).join(', ') || null, env.recebido_em);
  } else if (env.tipo === 'PEDIDO_CANCELADO') {
    const p = z.object({ id: z.string().max(64) }).parse(env.dados);
    db.prepare(`UPDATE solicitacoes_guia SET situacao = 'CANCELADA', respondido_em = datetime('now') WHERE empresa_id = ? AND origem_id = ? AND situacao IN ('PENDENTE','PRONTA')`).run(l.empresa_id, p.id);
  } else if (env.tipo === 'FECHAMENTO') {
    const f = Fechamento.parse(env.dados);
    const zip = Buffer.from(f.zip, 'base64');
    db.prepare(`INSERT OR IGNORE INTO fechamentos_recebidos (empresa_id, grupo, de, ate, nome, arquivos, tamanho, zip, enviado_por, recebido_em) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(l.empresa_id, env.grupo, f.de, f.ate, f.nome.replace(/[^\w.\- ]+/g, '_'), JSON.stringify(f.arquivos), zip.length, zip, f.enviado_por ?? null, env.recebido_em);
  }
  // tipos desconhecidos (versão mais nova do Kontor Empresas): ignorados
}

let emAndamento = new Set<number>();
/** Atualiza as conexões e traz o que chegou dos clientes. */
export async function sincronizar(escritorioId: number) {
  const c = cfg(escritorioId);
  if (!c) return { recebidos: 0, erros: [] as string[] };
  if (emAndamento.has(escritorioId)) return { recebidos: 0, erros: [] as string[] };
  emAndamento.add(escritorioId);
  try {
    const tk = token(c);
    const { vinculos } = await chamarApi<{ vinculos: { id: number; cnpj: string; tipo?: string; dispositivo?: string | null; chave: string; notificacoes?: boolean; criado_em: string; visto_em: string | null; revogado_em: string | null; revogado_por: string | null }[] }>('GET', '/vinculos', undefined, tk);
    const empresaDo = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND documento = ? AND eh_escritorio = 0 ORDER BY na_carteira DESC, id LIMIT 1');
    const mexidas = new Set<number>();
    db.transaction(() => {
      for (const v of vinculos) {
        const emp = empresaDo.get(escritorioId, v.cnpj) as { id: number } | undefined;
        if (!emp) continue;
        const a = db.prepare('SELECT * FROM conexao_aparelhos WHERE vinculo = ?').get(v.id) as any;
        const tipo = v.tipo === 'APP' ? 'APP' : 'EMPRESAS';
        const nome = tipo === 'APP' ? (v.dispositivo || 'Celular') : 'Kontor Gestão Empresas';
        if (!v.revogado_em) {
          if (a) db.prepare('UPDATE conexao_aparelhos SET visto_em = ?, chave = ?, nome = ?, notificacoes = ? WHERE vinculo = ?').run(v.visto_em, v.chave, nome, v.notificacoes ? 1 : 0, v.id);
          else {
            db.prepare(`INSERT INTO conexao_aparelhos (vinculo, empresa_id, cnpj, tipo, nome, chave, situacao, conectado_em, visto_em, notificacoes) VALUES (?,?,?,?,?,?,'CONECTADO',?,?,?)`)
              .run(v.id, emp.id, v.cnpj, tipo, nome, v.chave, v.criado_em, v.visto_em, v.notificacoes ? 1 : 0);
            db.prepare(`INSERT INTO conexao_clientes (empresa_id, cnpj, situacao) VALUES (?,?,'CONECTADO') ON CONFLICT(empresa_id) DO UPDATE SET codigo = NULL, codigo_expira = NULL`).run(emp.id, v.cnpj);
          }
          mexidas.add(emp.id);
        } else if (a?.situacao === 'CONECTADO') {
          const quem = tipo === 'APP' ? 'no celular' : 'no Kontor Empresas';
          const motivo = v.revogado_por === 'CLIENTE' ? `O cliente desfez a conexão ${quem}.` : v.revogado_por === 'NOVA_CONEXAO' ? 'Substituída por uma nova conexão.' : 'Conexão desfeita pelo escritório.';
          db.prepare(`UPDATE conexao_aparelhos SET situacao = 'DESCONECTADO', desconectado_em = ?, motivo = ? WHERE vinculo = ?`).run(v.revogado_em, motivo, v.id);
          mexidas.add(emp.id);
        }
      }
    })();
    for (const e of mexidas) atualizarResumo(e);
    const privada = decifrarTexto(c.privada);
    const chaveDe = (vinculo: number) => {
      const a = db.prepare("SELECT a.cnpj, a.chave FROM conexao_aparelhos a JOIN empresas e ON e.id = a.empresa_id WHERE a.vinculo = ? AND e.escritorio_id = ? AND a.situacao = 'CONECTADO'").get(vinculo, escritorioId) as any;
      return a?.chave ? chaveSessao(privada, a.chave, c.cnpj, a.cnpj) : null;
    };
    const r = await buscarEnvelopes(tk, chaveDe, (env) => tratar(escritorioId, env));
    db.prepare("UPDATE conexao_escritorio SET ultimo_sync = datetime('now'), ultimo_erro = ? WHERE escritorio_id = ?").run(r.erros.length ? r.erros.join(' ') : null, escritorioId);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE conexao_escritorio SET ultimo_erro = ? WHERE escritorio_id = ?").run(msg, escritorioId);
    throw e;
  } finally {
    emAndamento.delete(escritorioId);
  }
}

/** Timer do servidor: sincroniza os escritórios que têm clientes conectados ou convidados. */
export async function sincronizarTodos() {
  const lista = db.prepare(`SELECT DISTINCT ce.escritorio_id FROM conexao_escritorio ce JOIN empresas e ON e.escritorio_id = ce.escritorio_id
    JOIN conexao_clientes c ON c.empresa_id = e.id WHERE c.situacao IN ('CONECTADO','CONVITE') OR c.codigo IS NOT NULL`).all() as { escritorio_id: number }[];
  for (const x of lista) { try { await sincronizar(x.escritorio_id); } catch { /* erro fica em ultimo_erro */ } }
}

// ---- solicitações de guia ----

export function listarSolicitacoes(escritorioId: number, empresas: number[] | null) {
  const filtro = empresas ? `AND e.id IN (${empresas.join(',') || 'NULL'})` : '';
  return db.prepare(`SELECT s.id, s.empresa_id, s.tipo, s.periodo, s.data_pagamento, s.descricao, s.observacao, s.solicitante, s.situacao, s.resposta, s.criado_em, s.respondido_em,
      s.guia_id, g.titulo AS guia_titulo, g.valor AS guia_valor, g.validade AS guia_validade, u.nome AS respondido_por,
      e.documento, COALESCE(e.nome_fantasia, e.razao_social) AS cliente
    FROM solicitacoes_guia s JOIN empresas e ON e.id = s.empresa_id LEFT JOIN guias_recalculadas g ON g.id = s.guia_id LEFT JOIN usuarios u ON u.id = s.usuario_id
    WHERE e.escritorio_id = ? ${filtro} ORDER BY (s.situacao IN ('PENDENTE','PRONTA')) DESC, s.criado_em DESC, s.id DESC LIMIT 500`).all(escritorioId);
}

function solicitacao(escritorioId: number, id: number) {
  const s = db.prepare('SELECT s.* FROM solicitacoes_guia s JOIN empresas e ON e.id = s.empresa_id WHERE s.id = ? AND e.escritorio_id = ?').get(id, escritorioId) as any;
  if (!s) throw new ErroNegocio('Solicitação não encontrada.', 404);
  return s;
}
const aberta = (s: any) => { if (!['PENDENTE', 'PRONTA'].includes(s.situacao)) throw new ErroNegocio('Esta solicitação já foi respondida ou cancelada pelo cliente.'); };

export const DadosDarf = z.object({
  receita: z.string().trim(), descricao: z.string().trim().max(120).nullish(), vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valor: z.number().positive(), data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), referencia: z.string().trim().max(30).nullish(),
});

/** Gera a guia da solicitação pelo Integra Contador (o mesmo recálculo da Situação fiscal). */
export async function gerarDaSolicitacao(escritorioId: number, usuarioId: number, id: number, darf?: z.infer<typeof DadosDarf>) {
  const s = solicitacao(escritorioId, id);
  aberta(s);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const data = s.data_pagamento && s.data_pagamento >= hoje ? s.data_pagamento : hoje;
  let pedido: PedidoGuia;
  if (s.tipo === 'DAS') pedido = { tipo: 'DAS', periodo: s.periodo, descricao: null };
  else if (s.tipo === 'DCTFWEB') pedido = { tipo: 'DCTFWEB', periodo: s.periodo, data, descricao: null };
  else {
    if (!darf) throw new ErroNegocio('Para o DARF, informe o código da receita, o vencimento e o valor do principal.');
    pedido = { tipo: 'DARF', receita: darf.receita, descricao: darf.descricao ?? s.descricao ?? null, periodo: s.periodo, vencimento: darf.vencimento, valor: darf.valor, data: darf.data ?? data, referencia: darf.referencia ?? null };
  }
  const g = await gerarGuia(escritorioId, usuarioId, s.empresa_id, pedido);
  db.prepare(`UPDATE solicitacoes_guia SET guia_id = ?, situacao = 'PRONTA', usuario_id = ? WHERE id = ?`).run(g.id, usuarioId, id);
  return g;
}

/** Anexa um PDF de guia emitido fora do Kontor (ex.: no e-CAC ou no portal da prefeitura). */
export function anexarNaSolicitacao(escritorioId: number, usuarioId: number, id: number, d: { pdf: string; valor?: number | null; validade?: string | null; titulo?: string | null }) {
  const s = solicitacao(escritorioId, id);
  aberta(s);
  const pdf = Buffer.from(d.pdf, 'base64');
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new ErroNegocio('Envie a guia em PDF.');
  if (pdf.length > 8e6) throw new ErroNegocio('O PDF passa de 8 MB.');
  const nome = { DAS: 'DAS Simples Nacional', DCTFWEB: 'Guia DCTFWeb', DARF: 'DARF' }[s.tipo as 'DAS'];
  const titulo = (d.titulo?.trim() || `${nome}${s.descricao ? ` ${s.descricao}` : ''} — PA ${s.periodo}`).slice(0, 160);
  const r = db.prepare('INSERT INTO guias_recalculadas (empresa_id, tipo, titulo, periodo, valor, validade, pdf, usuario_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(s.empresa_id, s.tipo, titulo, s.periodo, d.valor ?? null, d.validade ?? null, pdf, usuarioId);
  db.prepare(`UPDATE solicitacoes_guia SET guia_id = ?, situacao = 'PRONTA', usuario_id = ? WHERE id = ?`).run(Number(r.lastInsertRowid), usuarioId, id);
  return { id: Number(r.lastInsertRowid) };
}

/** Quantos aparelhos do cliente estão conectados (Kontor Empresas e celulares). */
export const aparelhosConectados = (empresaId: number) => aparelhosAtivos(empresaId).length;

/** Envia a mesma mensagem a cada aparelho conectado do cliente (cada um tem a sua chave). Devolve quantos receberam. */
export async function enviarAoCliente(escritorioId: number, empresaId: number, tipo: string, dados: unknown) {
  const c = cfg(escritorioId);
  const lista = aparelhosAtivos(empresaId);
  if (!c || !lista.length) throw new ErroNegocio('Este cliente não está conectado pelo Kontor Empresas nem pelo aplicativo.');
  const privada = decifrarTexto(c.privada);
  let ok = 0;
  const falhas: string[] = [];
  for (const a of lista) {
    try { await enviarEnvelope(token(c), chaveSessao(privada, a.chave, c.cnpj, a.cnpj), tipo, dados, a.vinculo); ok++; }
    catch (e) {
      if (e instanceof FalhaApi && e.http === 410) { db.prepare(`UPDATE conexao_aparelhos SET situacao = 'DESCONECTADO', desconectado_em = datetime('now'), motivo = ? WHERE vinculo = ?`).run(e.message, a.vinculo); continue; }
      falhas.push(e instanceof Error ? e.message : String(e));
    }
  }
  atualizarResumo(empresaId);
  if (!ok) throw new ErroNegocio(falhas[0] ?? 'Nenhum aparelho do cliente está conectado.');
  return ok;
}

const arquivoGuia = (doc: string, tipo: string, periodo: string | null) => `${tipo}-${doc}-${String(periodo ?? '').replace(/\D+/g, '-').replace(/^-|-$/g, '')}.pdf`;

/** Dados de uma guia para o aplicativo/Kontor Empresas, com o código de barras e o Pix lidos do PDF (quando houver). */
export async function pacoteGuia(g: { tipo: string; titulo: string; periodo: string | null; valor: number | null; validade: string | null; pdf: Buffer }, doc: string, extra: Record<string, unknown> = {}) {
  const pag = await dadosDePagamento(g.pdf);
  return { tipo: g.tipo, titulo: g.titulo, periodo: g.periodo, valor: g.valor, validade: g.validade, nome: arquivoGuia(doc, g.tipo, g.periodo), pdf: g.pdf.toString('base64'),
    linha: pag.linha, pix: pag.pix, enviada_em: new Date().toISOString(), ...extra };
}

/** Documento que não é guia (recibo, declaração, espelho da folha) para o aplicativo/Kontor Empresas. */
export function pacoteDocumento(d: { tipo: string; titulo: string; competencia: string | null; nome: string; arquivo: Buffer; mime?: string }) {
  return { tipo: d.tipo, titulo: d.titulo, competencia: d.competencia, nome: d.nome.replace(/[^\w.\- ]+/g, '_'), mime: d.mime ?? 'application/pdf', arquivo: d.arquivo.toString('base64'), enviado_em: new Date().toISOString() };
}

// ---- envio automático pela conexão ----
const chaveAuto = (escritorioId: number) => `conexao_auto:${escritorioId}`;
/** Configuração do envio automático: guias e documentos vão sozinhos aos clientes conectados, sem o cliente pedir. */
export function lerEnvioAutomatico(escritorioId: number) {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(chaveAuto(escritorioId)) as any)?.valor;
  try { const d = v ? JSON.parse(v) : null; return { ligado: d?.ligado ?? true, desde: (d?.desde as string | undefined) ?? null }; } catch { return { ligado: true, desde: null }; }
}
export function salvarEnvioAutomatico(escritorioId: number, ligado: boolean) {
  const atual = lerEnvioAutomatico(escritorioId);
  // ao ligar, só o que ficar pronto daqui para a frente vai sozinho (não reenvia meses antigos)
  const desde = ligado ? (atual.ligado && atual.desde ? atual.desde : new Date().toISOString().replace('T', ' ').slice(0, 19)) : null;
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(chaveAuto(escritorioId), JSON.stringify({ ligado, desde }));
  return lerEnvioAutomatico(escritorioId);
}

/** Envia uma guia ao cliente (Kontor Empresas e celulares), com ou sem solicitação. */
export async function enviarGuiaAoCliente(escritorioId: number, usuarioId: number, empresaId: number, guiaId: number, mensagem?: string | null, solicitacaoId?: number) {
  const g = db.prepare('SELECT g.* FROM guias_recalculadas g JOIN empresas e ON e.id = g.empresa_id WHERE g.id = ? AND g.empresa_id = ? AND e.escritorio_id = ?').get(guiaId, empresaId, escritorioId) as any;
  if (!g) throw new ErroNegocio('Guia não encontrada.', 404);
  const s = solicitacaoId ? solicitacao(escritorioId, solicitacaoId) : null;
  const doc = (db.prepare('SELECT documento FROM empresas WHERE id = ?').get(empresaId) as any).documento as string;
  const n = await enviarAoCliente(escritorioId, empresaId, 'GUIA', await pacoteGuia({ ...g, pdf: Buffer.from(g.pdf) }, doc, { pedido: s?.origem_id ?? null, mensagem: mensagem?.trim() || null }));
  if (s) db.prepare(`UPDATE solicitacoes_guia SET situacao = 'ENVIADA', guia_id = ?, resposta = ?, usuario_id = ?, respondido_em = datetime('now') WHERE id = ?`).run(guiaId, mensagem?.trim() || null, usuarioId, s.id);
  return { ok: true, aparelhos: n };
}

export async function enviarSolicitacao(escritorioId: number, usuarioId: number, id: number, mensagem?: string | null) {
  const s = solicitacao(escritorioId, id);
  aberta(s);
  if (!s.guia_id) throw new ErroNegocio('Gere ou anexe a guia antes de enviar.');
  return enviarGuiaAoCliente(escritorioId, usuarioId, s.empresa_id, s.guia_id, mensagem, id);
}

export async function recusarSolicitacao(escritorioId: number, usuarioId: number, id: number, mensagem: string) {
  const s = solicitacao(escritorioId, id);
  aberta(s);
  const msg = mensagem.trim();
  if (msg.length < 3) throw new ErroNegocio('Escreva ao cliente o motivo.');
  await enviarAoCliente(escritorioId, s.empresa_id, 'PEDIDO_RESPOSTA', { pedido: s.origem_id, situacao: 'RECUSADO', mensagem: msg });
  db.prepare(`UPDATE solicitacoes_guia SET situacao = 'RECUSADA', resposta = ?, usuario_id = ?, respondido_em = datetime('now') WHERE id = ?`).run(msg, usuarioId, id);
  return { ok: true };
}

// ---- fechamentos recebidos ----

export function listarRecebidos(escritorioId: number, empresas: number[] | null, empresaId?: number) {
  const filtro = empresas ? `AND e.id IN (${empresas.join(',') || 'NULL'})` : '';
  return (db.prepare(`SELECT f.id, f.empresa_id, f.de, f.ate, f.nome, f.arquivos, f.tamanho, f.enviado_por, f.recebido_em, f.baixado_em, COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento
    FROM fechamentos_recebidos f JOIN empresas e ON e.id = f.empresa_id WHERE e.escritorio_id = ? ${empresaId ? 'AND e.id = ?' : ''} ${filtro} ORDER BY f.recebido_em DESC, f.id DESC LIMIT 300`)
    .all(...[escritorioId, ...(empresaId ? [empresaId] : [])]) as any[]).map((f) => {
    const arqs = JSON.parse(f.arquivos || '[]') as string[];
    return { ...f, arquivos: arqs.length, xml: arqs.filter((a) => /\.xml$/i.test(a)).length, pdf: arqs.filter((a) => /\.pdf$/i.test(a)).length, ofx: arqs.filter((a) => /\.ofx$/i.test(a)).length };
  });
}

export function zipRecebido(escritorioId: number, id: number) {
  const f = db.prepare('SELECT f.nome, f.zip FROM fechamentos_recebidos f JOIN empresas e ON e.id = f.empresa_id WHERE f.id = ? AND e.escritorio_id = ?').get(id, escritorioId) as any;
  if (!f) throw new ErroNegocio('Fechamento não encontrado.', 404);
  db.prepare("UPDATE fechamentos_recebidos SET baixado_em = COALESCE(baixado_em, datetime('now')) WHERE id = ?").run(id);
  return { zip: Buffer.from(f.zip), nome: /\.zip$/i.test(f.nome) ? f.nome : `${f.nome}.zip` };
}

// ---- boletos de honorários (cobranças do escritório) ----

/** Cliente da carteira que corresponde ao tomador da cobrança (mesmo CNPJ/CPF), se estiver conectado. */
function clienteDaCobranca(c: any): number | null {
  const t = db.prepare('SELECT t.documento, e.escritorio_id FROM tomadores t JOIN empresas e ON e.id = t.empresa_id WHERE t.id = ?').get(c.tomador_id) as any;
  if (!t?.documento) return null;
  const cli = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND documento = ? AND eh_escritorio = 0 ORDER BY na_carteira DESC, id LIMIT 1').get(t.escritorio_id, t.documento) as { id: number } | undefined;
  return cli && aparelhosConectados(cli.id) ? cli.id : null;
}
const jaFoi = (chave: string) => !!db.prepare('SELECT 1 FROM conexao_envios WHERE chave = ?').get(chave);
const marcar = (chave: string, empresaId: number) => db.prepare('INSERT OR IGNORE INTO conexao_envios (chave, empresa_id) VALUES (?, ?)').run(chave, empresaId);

/**
 * Manda o boleto (ou Pix) de uma cobrança do escritório ao Kontor Empresas e ao aplicativo do cliente conectado.
 * Devolve quantos aparelhos receberam (0 = cliente não conectado ou cobrança ainda sem boleto/Pix).
 */
export async function enviarCobrancaPelaConexao(escritorioId: number, cobrancaId: number, forcar = false) {
  const c = obterCobranca(cobrancaId);
  if (!c || c.status === 'CANCELADO' || c.status === 'PAGO') return 0;
  if (c.forma === 'PIX' ? !c.pix_copia_cola : !c.linha_digitavel) return 0;
  const cli = clienteDaCobranca(c);
  if (!cli) return 0;
  const chave = `COB:${c.id}:${c.vencimento}:${c.valor}`; // reemitida (outro vencimento ou valor) vai de novo e substitui a anterior
  if (!forcar && jaFoi(chave)) return 0;
  const dm = await demonstrativoPdf(c.id);
  const ref = referenciaDa(c);
  const n = await enviarAoCliente(escritorioId, cli, 'GUIA', {
    tipo: 'BOLETO', titulo: `Honorários — ${ref}`, periodo: ref, valor: c.valor, validade: c.vencimento, nome: dm.nome, pdf: dm.pdf.toString('base64'),
    linha: c.forma === 'PIX' ? null : c.linha_digitavel, pix: c.pix_copia_cola ?? null, ref: `COB-${c.id}`, mensagem: c.descricao ? String(c.descricao).slice(0, 300) : null,
    pedido: null, competencia: null, enviada_em: new Date().toISOString(),
  });
  marcar(chave, cli);
  return n;
}

/**
 * Volta automática: boletos novos, pagamentos confirmados e cancelamentos das cobranças do escritório
 * vão sozinhos aos clientes conectados (só o que acontecer depois de ligar o envio automático).
 */
export async function envioAutomaticoCobrancas() {
  const escritorios = db.prepare(`SELECT DISTINCT e.escritorio_id FROM conexao_aparelhos a JOIN empresas e ON e.id = a.empresa_id WHERE a.situacao = 'CONECTADO'`).all() as { escritorio_id: number }[];
  for (const { escritorio_id: esc } of escritorios) {
    const cfg = lerEnvioAutomatico(esc);
    if (!cfg.ligado || !cfg.desde) continue;
    const cobs = db.prepare(`SELECT c.id, c.status, c.pago_em, c.valor_pago FROM cobrancas c JOIN empresas e ON e.id = c.empresa_id
      WHERE e.escritorio_id = ? AND (c.criado_em >= ? OR c.pago_em >= ?) ORDER BY c.id`).all(esc, cfg.desde, cfg.desde.slice(0, 10)) as any[];
    for (const x of cobs) {
      try {
        if (x.status === 'PAGO' || x.status === 'CANCELADO') {
          const chaveBoleto = db.prepare("SELECT empresa_id FROM conexao_envios WHERE chave LIKE ?").get(`COB:${x.id}:%`) as { empresa_id: number } | undefined;
          if (!chaveBoleto || !aparelhosConectados(chaveBoleto.empresa_id)) continue; // o cliente nunca recebeu este boleto pela conexão
          const chave = `COB-${x.status === 'PAGO' ? 'PAGO' : 'CANCELADA'}:${x.id}`;
          if (jaFoi(chave)) continue;
          if (x.status === 'PAGO') await enviarAoCliente(esc, chaveBoleto.empresa_id, 'PAGAMENTO', { ref: `COB-${x.id}`, pago_em: x.pago_em, valor_pago: x.valor_pago ?? null });
          else await enviarAoCliente(esc, chaveBoleto.empresa_id, 'COBRANCA_CANCELADA', { ref: `COB-${x.id}` });
          marcar(chave, chaveBoleto.empresa_id);
        } else await enviarCobrancaPelaConexao(esc, x.id);
      } catch { /* tenta de novo na próxima volta */ }
    }
  }
}
