import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exigirLogin, type Usuario } from './auth.js';
import {
  ConfigRadar, EdicaoLead, NovoContato, NovoLead, Pesquisa, adicionarLead, atualizarEmpresa, configPublicaRadar, detalheEmpresa, editarLead, excluirLead,
  listarAuditoria, painelRadar, pesquisar, registrarContato, salvarConfigRadar, sugestaoCadastro,
} from './servicos/radar.js';

const u = (req: FastifyRequest) => req.usuario as Usuario;
const id = (req: FastifyRequest) => Number((req.params as any).id);

/** Radar de Oportunidades (prospecção). Cada escritório só enxerga o próprio radar e os próprios leads. */
export async function rotasRadar(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook('preHandler', exigirLogin);
    api.get('/api/radar/painel', async (req) => painelRadar(u(req).escritorio_id, z.coerce.number().int().min(7).max(365).default(30).parse((req.query as any)?.dias)));
    api.get('/api/radar/config', async (req) => configPublicaRadar(u(req).escritorio_id));
    api.put('/api/radar/config', async (req) => salvarConfigRadar(u(req).escritorio_id, u(req).id, ConfigRadar.parse(req.body)));
    api.get('/api/radar/auditoria', async (req) => listarAuditoria(u(req).escritorio_id));
    api.post('/api/radar/pesquisar', async (req) => pesquisar(u(req).escritorio_id, u(req).id, Pesquisa.parse(req.body ?? {})));
    api.get('/api/radar/empresas/:cnpj', async (req) => detalheEmpresa(u(req).escritorio_id, (req.params as any).cnpj));
    api.post('/api/radar/empresas/:cnpj/atualizar', async (req) => atualizarEmpresa(u(req).escritorio_id, u(req).id, (req.params as any).cnpj));
    api.post('/api/radar/leads', async (req) => adicionarLead(u(req).escritorio_id, u(req).id, NovoLead.parse(req.body)));
    api.put('/api/radar/leads/:id', async (req) => editarLead(u(req).escritorio_id, u(req).id, id(req), EdicaoLead.parse(req.body)));
    api.delete('/api/radar/leads/:id', async (req) => excluirLead(u(req).escritorio_id, u(req).id, id(req)));
    api.post('/api/radar/leads/:id/contatos', async (req) => registrarContato(u(req).escritorio_id, u(req).id, id(req), NovoContato.parse(req.body)));
    api.get('/api/radar/leads/:id/cadastro', async (req) => sugestaoCadastro(u(req).escritorio_id, id(req)));
  });
}
