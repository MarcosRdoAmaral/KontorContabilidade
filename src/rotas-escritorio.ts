import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from './db.js';
import { exigirLogin, exigirPapel, restritoAEmpresas, type Usuario } from './auth.js';
import { ErroNegocio } from './servicos/emissao.js';
import { ClienteCarteira, criarCliente, editarCliente, listarCarteira, visaoGeral } from './servicos/carteira.js';
import { Certificado, excluirCertificado, listarCertificados, renovarCertificado, resumoCertificados, salvarCertificado, TIPOS_CERT } from './servicos/certificados.js';
import { AndamentoTarefa, ExcecoesCliente, Obrigacao, ROTULO_REGIME, definirInicioDoControle, inicioDoControle, atualizarTarefa, entregarEmLote, excluirObrigacao, listarObrigacoes, listarTarefas, obrigacoesDoCliente, resumoTarefas, salvarObrigacao, salvarObrigacoesDoCliente } from './servicos/obrigacoes.js';
import { CAMPOS_MODELO, ESCOPO_PADRAO, MarcaDagua, configMarca, imagemMarca, pdfExemplo, removerImagemMarca, salvarImagemMarca, salvarMarca, tipoImagem, Contrato, Modelo, ROTULO_INDICE, acumulado12Meses, anexarAssinado, aplicarReajuste, arquivoAssinado, configHonorarios, criarContrato, editarContrato, emitirDecimoTerceiro, excluirContrato, excluirModelo, historicoReajustes, inadimplencia, listarContratos, listarDecimoTerceiro, listarModelos, mudarStatus, pdfDoContrato, salvarConfigHonorarios, salvarModelo, sincronizarFaturamento, textoDoContrato } from './servicos/honorarios.js';
import { automaticaParaTodos, capturarTodos, notasDoMes, pacoteDoMes, statusAutXml, statusCaptura } from './servicos/captura.js';
import { xmlSaida } from './servicos/nfe-saidas.js';
import { consultarVarios, detalheSituacao, painelSituacao, pdfSituacao, resumoSituacoes } from './servicos/situacao-fiscal.js';
import { CONFERIVEIS, ConfigIntegra, conferirNaReceita, configPublica as configIntegra, previaConferencia, salvarConfig as salvarIntegra, testarConexao } from './servicos/integra-contador.js';
import { xmlNfseCapturada } from './servicos/nfse-capturadas.js';
import { ConfigAvisos, configAvisos, enviarResumo, montarResumo, salvarAvisos } from './servicos/avisos.js';

/** Rotas exclusivas do Kontor Gestão Contabilidade (gestão do escritório). Permissões em src/auth.ts (REGRAS). */

const u = (req: FastifyRequest) => req.usuario as Usuario;
const id = (req: FastifyRequest, nome = 'id') => Number((req.params as any)[nome]);
const MES = z.string().regex(/^\d{4}-\d{2}$/);
const mesDe = (q: any) => MES.parse(q?.mes ?? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7));

/** null = todas as empresas do escritório; senão só as liberadas para o usuário. */
function empresasDoUsuario(usr: Usuario): number[] | null {
  if (!restritoAEmpresas(usr)) return null;
  return (db.prepare('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?').all(usr.id) as { empresa_id: number }[]).map((r) => r.empresa_id);
}
function checar(req: FastifyRequest, empresaId: number) {
  const e = db.prepare('SELECT escritorio_id FROM empresas WHERE id = ?').get(empresaId) as any;
  const lista = empresasDoUsuario(u(req));
  if (!e || e.escritorio_id !== u(req).escritorio_id || (lista && !lista.includes(empresaId))) throw new ErroNegocio('Cliente não encontrado.', 404);
}

export async function rotasEscritorio(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook('preHandler', exigirLogin);

    api.get('/api/escritorio/tabelas', async () => ({ regimes: ROTULO_REGIME, tiposCertificado: TIPOS_CERT, indices: ROTULO_INDICE, camposModelo: CAMPOS_MODELO, escopoPadrao: ESCOPO_PADRAO }));
    api.get('/api/escritorio/equipe', async (req) => db.prepare('SELECT id, nome, login FROM usuarios WHERE escritorio_id = ? AND ativo = 1 AND mestre = 0 ORDER BY nome').all(u(req).escritorio_id));
    api.get('/api/escritorio/visao', async (req) => visaoGeral(u(req).escritorio_id, mesDe(req.query), empresasDoUsuario(u(req))));

    // ---------- Carteira ----------
    api.get('/api/escritorio/carteira', async (req) => listarCarteira(u(req).escritorio_id, empresasDoUsuario(u(req))));
    api.post('/api/escritorio/carteira', { preHandler: exigirPapel('admin', 'operador') }, async (req) => ({ id: criarCliente(u(req).escritorio_id, ClienteCarteira.parse(req.body)) }));
    api.put('/api/escritorio/carteira/:id', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      checar(req, id(req));
      editarCliente(u(req).escritorio_id, id(req), ClienteCarteira.parse(req.body));
      return { ok: true };
    });
    api.get('/api/escritorio/carteira/:id/obrigacoes', async (req) => { checar(req, id(req)); return obrigacoesDoCliente(u(req).escritorio_id, id(req)); });
    api.put('/api/escritorio/carteira/:id/obrigacoes', async (req) => {
      checar(req, id(req));
      salvarObrigacoesDoCliente(u(req).escritorio_id, id(req), ExcecoesCliente.parse(req.body));
      return { ok: true };
    });

    // ---------- Obrigações e prazos ----------
    api.get('/api/escritorio/tarefas', async (req) => {
      const q = req.query as any;
      const lista = listarTarefas(u(req).escritorio_id, {
        mes: mesDe(q), atrasadas: q.atrasadas !== '0', empresaId: q.empresa ? Number(q.empresa) : undefined,
        responsavelId: q.responsavel ? Number(q.responsavel) : undefined, empresas: empresasDoUsuario(u(req)),
      });
      return { tarefas: lista, resumo: resumoTarefas(lista) };
    });
    api.put('/api/escritorio/tarefas/:id', async (req) => {
      const t = db.prepare('SELECT empresa_id FROM tarefas WHERE id = ?').get(id(req)) as any;
      if (!t) throw new ErroNegocio('Tarefa não encontrada.', 404);
      checar(req, t.empresa_id);
      atualizarTarefa(u(req).escritorio_id, u(req).id, id(req), AndamentoTarefa.parse(req.body));
      return { ok: true };
    });
    api.post('/api/escritorio/tarefas/entregar', async (req) => {
      const ids = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body).ids;
      const permitidas = empresasDoUsuario(u(req));
      const validos = permitidas ? ids.filter((t) => permitidas.includes((db.prepare('SELECT empresa_id FROM tarefas WHERE id = ?').get(t) as any)?.empresa_id)) : ids;
      return { entregues: entregarEmLote(u(req).escritorio_id, u(req).id, validos) };
    });
    api.get('/api/escritorio/obrigacoes', async (req) => listarObrigacoes(u(req).escritorio_id));
    api.get('/api/escritorio/obrigacoes/inicio', async (req) => ({ inicio: inicioDoControle(u(req).escritorio_id) }));
    api.put('/api/escritorio/obrigacoes/inicio', async (req) => { definirInicioDoControle(u(req).escritorio_id, z.object({ inicio: z.string() }).parse(req.body).inicio); return { ok: true }; });
    api.post('/api/escritorio/obrigacoes', async (req) => ({ id: salvarObrigacao(u(req).escritorio_id, null, Obrigacao.parse(req.body)) }));
    api.put('/api/escritorio/obrigacoes/:id', async (req) => ({ id: salvarObrigacao(u(req).escritorio_id, id(req), Obrigacao.parse(req.body)) }));
    api.delete('/api/escritorio/obrigacoes/:id', async (req) => { excluirObrigacao(u(req).escritorio_id, id(req)); return { ok: true }; });

    // ---------- Certificados ----------
    api.get('/api/escritorio/certificados', async (req) => {
      const permitidas = empresasDoUsuario(u(req));
      const lista = listarCertificados(u(req).escritorio_id).filter((c) => !permitidas || (c.empresa_id && permitidas.includes(c.empresa_id)));
      return { certificados: lista, resumo: resumoCertificados(lista) };
    });
    api.post('/api/escritorio/certificados', async (req) => {
      const d = Certificado.parse(req.body);
      if (d.empresa_id) checar(req, d.empresa_id);
      return { id: salvarCertificado(u(req).escritorio_id, null, d) };
    });
    api.put('/api/escritorio/certificados/:id', async (req) => {
      const d = Certificado.parse(req.body);
      if (d.empresa_id) checar(req, d.empresa_id);
      return { id: salvarCertificado(u(req).escritorio_id, id(req), d) };
    });
    api.post('/api/escritorio/certificados/:id/renovar', async (req) => {
      const d = z.object({ validade: z.string(), observacoes: z.string().nullish() }).parse(req.body);
      return { id: renovarCertificado(u(req).escritorio_id, id(req), d.validade, d.observacoes) };
    });
    api.delete('/api/escritorio/certificados/:id', async (req) => { excluirCertificado(u(req).escritorio_id, id(req)); return { ok: true }; });

    // ---------- Contratos e honorários ----------
    api.get('/api/escritorio/honorarios/config', async (req) => configHonorarios(u(req).escritorio_id));
    api.put('/api/escritorio/honorarios/config', async (req) => {
      const d = z.object({ servicoId: z.number().int().positive().nullable() }).parse(req.body);
      salvarConfigHonorarios(u(req).escritorio_id, d.servicoId);
      // contratos já assinados passam a faturar com o serviço escolhido
      const avisos: string[] = [];
      if (d.servicoId) for (const c of listarContratos(u(req).escritorio_id).filter((x) => x.status === 'ASSINADO')) avisos.push(...(await sincronizarFaturamento(u(req).escritorio_id, c.id)).avisos);
      return { ok: true, avisos: [...new Set(avisos)] };
    });
    api.get('/api/escritorio/contratos', async (req) => {
      const permitidas = empresasDoUsuario(u(req));
      return listarContratos(u(req).escritorio_id).filter((c) => !permitidas || permitidas.includes(c.empresa_id));
    });
    api.post('/api/escritorio/contratos', async (req) => {
      const d = Contrato.parse(req.body);
      checar(req, d.empresa_id);
      return criarContrato(u(req).escritorio_id, d);
    });
    api.put('/api/escritorio/contratos/:id', async (req) => {
      const d = Contrato.parse(req.body);
      checar(req, d.empresa_id);
      return editarContrato(u(req).escritorio_id, id(req), d);
    });
    api.delete('/api/escritorio/contratos/:id', async (req) => { excluirContrato(u(req).escritorio_id, id(req)); return { ok: true }; });
    api.post('/api/escritorio/contratos/:id/status', async (req) => {
      const d = z.object({ status: z.enum(['RASCUNHO', 'ENVIADO', 'ASSINADO', 'ENCERRADO']), data: z.string().nullish() }).parse(req.body);
      return mudarStatus(u(req).escritorio_id, id(req), d.status, d.data);
    });
    api.get('/api/escritorio/contratos/:id/texto', async (req) => textoDoContrato(u(req).escritorio_id, id(req)));
    api.get('/api/escritorio/contratos/:id/pdf', async (req, reply) => {
      const pdf = await pdfDoContrato(u(req).escritorio_id, id(req));
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="contrato-${id(req)}.pdf"`).send(pdf);
    });
    api.post('/api/escritorio/contratos/:id/assinado', async (req) => {
      let arquivo: Buffer | null = null, nome = 'contrato-assinado';
      for await (const parte of req.parts()) if (parte.type === 'file') { arquivo = await parte.toBuffer(); nome = parte.filename || nome; }
      if (!arquivo) throw new ErroNegocio('Envie o arquivo do contrato assinado.');
      anexarAssinado(u(req).escritorio_id, id(req), arquivo, nome);
      return { ok: true };
    });
    api.get('/api/escritorio/contratos/:id/assinado', async (req, reply) => {
      const a = arquivoAssinado(u(req).escritorio_id, id(req));
      return reply.type(a.tipo).header('Content-Disposition', `inline; filename="${a.nome}"`).send(a.arquivo);
    });
    api.get('/api/escritorio/contratos/:id/reajustes', async (req) => historicoReajustes(u(req).escritorio_id, id(req)));
    api.get('/api/escritorio/indices/:indice', async (req) => acumulado12Meses(String((req.params as any).indice), mesDe(req.query)));
    api.post('/api/escritorio/contratos/:id/reajuste', async (req) => {
      const d = z.object({ percentual: z.number(), data: z.string().nullish() }).parse(req.body);
      return aplicarReajuste(u(req).escritorio_id, u(req).id, id(req), d.percentual, d.data);
    });
    api.get('/api/escritorio/decimo-terceiro', async (req) => listarDecimoTerceiro(u(req).escritorio_id, Number((req.query as any).ano) || new Date().getFullYear()));
    api.post('/api/escritorio/contratos/:id/decimo-terceiro', async (req) => {
      const d = z.object({ ano: z.number().int().min(2020).max(2100) }).parse(req.body);
      return emitirDecimoTerceiro(u(req), id(req), d.ano);
    });
    api.get('/api/escritorio/inadimplencia', async (req) => inadimplencia(u(req).escritorio_id));
    api.get('/api/escritorio/modelos', async (req) => listarModelos(u(req).escritorio_id));
    api.get('/api/escritorio/contratos-exemplo', async (req, reply) => {
      const pdf = await pdfExemplo(u(req).escritorio_id, Number((req.query as any).modelo) || null);
      return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="contrato-exemplo.pdf"').send(pdf);
    });
    api.get('/api/escritorio/contrato-marca', async (req) => configMarca(u(req).escritorio_id));
    api.put('/api/escritorio/contrato-marca', async (req) => { salvarMarca(u(req).escritorio_id, MarcaDagua.parse(req.body)); return { ok: true }; });
    api.post('/api/escritorio/contrato-marca/imagem', async (req) => {
      let img: Buffer | null = null;
      for await (const parte of req.parts()) if (parte.type === 'file') img = await parte.toBuffer();
      if (!img) throw new ErroNegocio('Envie a imagem da marca d’água.');
      salvarImagemMarca(u(req).escritorio_id, img);
      return { ok: true };
    });
    api.get('/api/escritorio/contrato-marca/imagem', async (req, reply) => {
      const img = imagemMarca(u(req).escritorio_id);
      if (!img) throw new ErroNegocio('Nenhuma marca d’água definida.', 404);
      return reply.type(tipoImagem(img) ?? 'application/octet-stream').send(img);
    });
    api.delete('/api/escritorio/contrato-marca/imagem', async (req) => { removerImagemMarca(u(req).escritorio_id); return { ok: true }; });
    api.post('/api/escritorio/modelos', async (req) => ({ id: salvarModelo(u(req).escritorio_id, null, Modelo.parse(req.body)) }));
    api.put('/api/escritorio/modelos/:id', async (req) => ({ id: salvarModelo(u(req).escritorio_id, id(req), Modelo.parse(req.body)) }));
    api.delete('/api/escritorio/modelos/:id', async (req) => { excluirModelo(u(req).escritorio_id, id(req)); return { ok: true }; });

    // ---------- Captura de documentos ----------
    api.get('/api/escritorio/captura', async (req) => statusCaptura(u(req).escritorio_id, mesDe(req.query), empresasDoUsuario(u(req))));
    api.get('/api/escritorio/captura/autxml', async (req) => statusAutXml(u(req).escritorio_id, mesDe(req.query)));
    api.get('/api/escritorio/captura/:id/notas', async (req) => { checar(req, id(req)); return notasDoMes(u(req).escritorio_id, id(req), mesDe(req.query)); });
    api.get('/api/escritorio/captura/:id/xml/:chave', async (req, reply) => {
      checar(req, id(req));
      const chave = String((req.params as any).chave);
      const doc = (db.prepare('SELECT documento FROM empresas WHERE id = ?').get(id(req)) as any).documento;
      if (/^\d{44}$/.test(chave)) {
        const x = xmlSaida(u(req).escritorio_id, chave);
        if (x.emitente_documento !== doc) throw new ErroNegocio('XML não encontrado.', 404);
        return reply.type('application/xml').header('Content-Disposition', `attachment; filename="NFe_${chave}.xml"`).send(x.xml);
      }
      const x = xmlNfseCapturada(id(req), chave);
      return reply.type('application/xml').header('Content-Disposition', `attachment; filename="NFSe_${x.numero ?? chave}.xml"`).send(x.xml);
    });
    api.post('/api/escritorio/captura/buscar', async (req) => capturarTodos(u(req).escritorio_id, empresasDoUsuario(u(req))));
    api.post('/api/escritorio/captura/automatica', async (req) => automaticaParaTodos(u(req).escritorio_id, z.object({ ligar: z.boolean() }).parse(req.body).ligar, empresasDoUsuario(u(req))));
    api.get('/api/escritorio/captura/:id/pacote', async (req, reply) => {
      checar(req, id(req));
      const p = await pacoteDoMes(id(req), mesDe(req.query));
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${p.nome}"`).send(p.zip);
    });

    // ---------- Integra Contador (SERPRO) ----------
    api.get('/api/escritorio/integra/config', async (req) => ({ ...configIntegra(u(req).escritorio_id), conferiveis: CONFERIVEIS }));
    api.put('/api/escritorio/integra/config', async (req) => { salvarIntegra(u(req).escritorio_id, ConfigIntegra.parse(req.body)); return { ok: true }; });
    api.post('/api/escritorio/integra/testar', async (req) => testarConexao(u(req).escritorio_id));
    api.get('/api/escritorio/integra/previa', async (req) => ({ ...previaConferencia(u(req).escritorio_id, mesDe(req.query), empresasDoUsuario(u(req))), configurado: configIntegra(u(req).escritorio_id).configurado }));
    api.post('/api/escritorio/integra/conferir', async (req) => conferirNaReceita(u(req).escritorio_id, u(req).id, MES.parse((req.body as any)?.mes), empresasDoUsuario(u(req))));

    // ---------- Situação fiscal (Integra Contador) ----------
    api.get('/api/escritorio/situacao-fiscal', async (req) => ({ clientes: painelSituacao(u(req).escritorio_id, empresasDoUsuario(u(req))), resumo: resumoSituacoes(u(req).escritorio_id, empresasDoUsuario(u(req))), configurado: configIntegra(u(req).escritorio_id).configurado }));
    api.post('/api/escritorio/situacao-fiscal/consultar', async (req) => {
      const ids = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).parse(req.body).ids;
      for (const i of ids) checar(req, i);
      return consultarVarios(u(req).escritorio_id, u(req).id, ids);
    });
    api.get('/api/escritorio/situacao-fiscal/:id', async (req) => {
      const d = detalheSituacao(u(req).escritorio_id, id(req));
      checar(req, d.empresa_id);
      return d;
    });
    api.get('/api/escritorio/situacao-fiscal/:id/pdf', async (req, reply) => {
      const d = detalheSituacao(u(req).escritorio_id, id(req));
      checar(req, d.empresa_id);
      const p = pdfSituacao(u(req).escritorio_id, id(req));
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${p.nome}"`).send(p.pdf);
    });

    // ---------- Avisos por e-mail ----------
    api.get('/api/escritorio/avisos', async (req) => ({ ...configAvisos(u(req).escritorio_id), previa: montarResumo(u(req).escritorio_id) }));
    api.put('/api/escritorio/avisos', async (req) => { salvarAvisos(u(req).escritorio_id, ConfigAvisos.parse(req.body)); return { ok: true }; });
    api.post('/api/escritorio/avisos/enviar', async (req) => enviarResumo(u(req).escritorio_id, true));
  });
}
