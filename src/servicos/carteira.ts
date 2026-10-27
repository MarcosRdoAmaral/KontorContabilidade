import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { codMunicipioValido, documentoValido, limparDoc, soDigitos } from '../nfse/validacao.js';
import { REGIMES, limparTarefasQueNaoSeAplicam, listarTarefas, regimeDe, resumoTarefas } from './obrigacoes.js';
import { listarCertificados, resumoCertificados } from './certificados.js';

/**
 * Carteira de clientes do escritório. Cada cliente é uma "empresa" do sistema (a mesma usada para emitir NFS-e e
 * buscar NF-e), com os dados de atendimento: regime, situação, responsável, contato e perfil (funcionários, ICMS, ISS),
 * que definem as obrigações geradas.
 */

const opcional = (s: z.ZodTypeAny) => s.nullish().or(z.literal('').transform(() => null));

export const ClienteCarteira = z.object({
  documento: z.string().transform(limparDoc).refine(documentoValido, 'CNPJ/CPF inválido'),
  razao_social: z.string().trim().min(2).max(200),
  nome_fantasia: opcional(z.string().trim().max(200)),
  cod_municipio: z.string().refine(codMunicipioValido, 'Município (código IBGE de 7 dígitos) obrigatório'),
  uf: z.string().length(2).nullish(),
  email: opcional(z.string().trim().email('E-mail inválido')),
  inscricao_municipal: opcional(z.string().trim().max(30)),
  inscricao_estadual: opcional(z.string().trim().max(30)),
  cnae: opcional(z.string().trim().max(20)),
  regime: z.enum(REGIMES),
  situacao: z.enum(['ATIVO', 'SUSPENSO', 'ENCERRADO']).default('ATIVO'),
  responsavel_id: z.number().int().positive().nullish(),
  cliente_desde: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  encerrado_em: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  contato_nome: opcional(z.string().trim().max(120)),
  contato_fone: z.string().nullish().transform((f) => (f ? soDigitos(f) || null : null)),
  tem_funcionarios: z.boolean().default(false),
  contribuinte_icms: z.boolean().default(false),
  contribuinte_iss: z.boolean().default(true),
  eh_escritorio: z.boolean().default(false),
  observacoes: opcional(z.string().trim().max(2000)),
  cep: z.string().nullish().transform((c) => (c ? soDigitos(c) || null : null)),
  logradouro: opcional(z.string().trim().max(150)),
  numero: opcional(z.string().trim().max(20)),
  complemento: opcional(z.string().trim().max(80)),
  bairro: opcional(z.string().trim().max(80)),
  cidade: opcional(z.string().trim().max(80)),
  crc: opcional(z.string().trim().max(30)),
  rep_nome: opcional(z.string().trim().max(150)),
  rep_cpf: z.string().nullish().transform((c) => (c ? soDigitos(c) || null : null)).refine((c) => !c || c.length === 11, 'CPF do representante deve ter 11 dígitos'),
  rep_rg: opcional(z.string().trim().max(30)),
  rep_nacionalidade: opcional(z.string().trim().max(40)),
  rep_estado_civil: opcional(z.string().trim().max(40)),
  rep_profissao: opcional(z.string().trim().max(60)),
}).refine((c) => c.situacao !== 'ENCERRADO' || !!c.encerrado_em, { path: ['encerrado_em'], message: 'Informe a data de encerramento' });
export type ClienteCarteira = z.infer<typeof ClienteCarteira>;

/** Opção pelo Simples usada na emissão da NFS-e, coerente com o regime da carteira. */
const EXTRAS = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'crc', 'rep_nome', 'rep_cpf', 'rep_rg', 'rep_nacionalidade', 'rep_estado_civil', 'rep_profissao'] as const;
function gravarExtras(id: number, d: ClienteCarteira) {
  db.prepare(`UPDATE empresas SET ${EXTRAS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...EXTRAS.map((c) => (d as any)[c] ?? null), id);
}

const opSimples = (r: string) => (r === 'MEI' ? 2 : r === 'SIMPLES' ? 3 : 1);

function conferirResponsavel(escritorioId: number, id?: number | null) {
  if (id && !db.prepare('SELECT 1 FROM usuarios WHERE id = ? AND escritorio_id = ? AND ativo = 1').get(id, escritorioId)) throw new ErroNegocio('Responsável inválido.');
}

export function criarCliente(escritorioId: number, d: ClienteCarteira): number {
  conferirResponsavel(escritorioId, d.responsavel_id);
  if (db.prepare('SELECT 1 FROM empresas WHERE escritorio_id = ? AND documento = ?').get(escritorioId, d.documento)) throw new ErroNegocio('Este CNPJ/CPF já está na carteira.', 409);
  return db.transaction(() => {
    if (d.eh_escritorio) db.prepare('UPDATE empresas SET eh_escritorio = 0 WHERE escritorio_id = ?').run(escritorioId);
    const op = opSimples(d.regime);
    const r = db.prepare(`INSERT INTO empresas (escritorio_id, documento, razao_social, nome_fantasia, cod_municipio, uf, email, inscricao_municipal, inscricao_estadual, cnae,
        op_simp_nac, reg_ap_trib_sn, regime, situacao, responsavel_id, cliente_desde, encerrado_em, contato_nome, contato_fone, tem_funcionarios, contribuinte_icms, contribuinte_iss, eh_escritorio, observacoes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(escritorioId, d.documento, d.razao_social, d.nome_fantasia ?? null, d.cod_municipio, d.uf ?? null, d.email ?? null,
      d.inscricao_municipal ?? null, d.inscricao_estadual ?? null, d.cnae ?? null, op, op === 3 ? 1 : null, d.regime, d.situacao, d.responsavel_id ?? null,
      d.cliente_desde ?? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), d.situacao === 'ENCERRADO' ? d.encerrado_em ?? null : null,
      d.contato_nome ?? null, d.contato_fone ?? null, d.tem_funcionarios ? 1 : 0, d.contribuinte_icms ? 1 : 0, d.contribuinte_iss ? 1 : 0, d.eh_escritorio ? 1 : 0, d.observacoes ?? null);
    const id = Number(r.lastInsertRowid);
    gravarExtras(id, d);
    return id;
  })();
}

export function editarCliente(escritorioId: number, id: number, d: ClienteCarteira) {
  conferirResponsavel(escritorioId, d.responsavel_id);
  const atual = db.prepare('SELECT * FROM empresas WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!atual) throw new ErroNegocio('Cliente não encontrado.', 404);
  const outro = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND documento = ? AND id != ?').get(escritorioId, d.documento, id);
  if (outro) throw new ErroNegocio('Outro cliente da carteira já usa este CNPJ/CPF.', 409);
  db.transaction(() => {
    if (d.eh_escritorio) db.prepare('UPDATE empresas SET eh_escritorio = 0 WHERE escritorio_id = ? AND id != ?').run(escritorioId, id);
    const op = opSimples(d.regime);
    db.prepare(`UPDATE empresas SET documento=?, razao_social=?, nome_fantasia=?, cod_municipio=?, uf=?, email=?, inscricao_municipal=?, inscricao_estadual=?, cnae=?,
        op_simp_nac=?, reg_ap_trib_sn=?, regime=?, situacao=?, responsavel_id=?, cliente_desde=?, encerrado_em=?, contato_nome=?, contato_fone=?,
        tem_funcionarios=?, contribuinte_icms=?, contribuinte_iss=?, eh_escritorio=?, observacoes=?, ativo=? WHERE id = ?`)
      .run(d.documento, d.razao_social, d.nome_fantasia ?? null, d.cod_municipio, d.uf ?? null, d.email ?? null, d.inscricao_municipal ?? null, d.inscricao_estadual ?? null, d.cnae ?? null,
        op, op === 3 ? atual.reg_ap_trib_sn ?? 1 : null, d.regime, d.situacao, d.responsavel_id ?? null, d.cliente_desde ?? atual.cliente_desde,
        d.situacao === 'ENCERRADO' ? d.encerrado_em ?? null : null, d.contato_nome ?? null, d.contato_fone ?? null,
        d.tem_funcionarios ? 1 : 0, d.contribuinte_icms ? 1 : 0, d.contribuinte_iss ? 1 : 0, d.eh_escritorio ? 1 : 0, d.observacoes ?? null, d.situacao === 'ENCERRADO' ? 0 : 1, id);
    gravarExtras(id, d);
    // novos responsáveis assumem as tarefas abertas que eram do anterior
    if ((d.responsavel_id ?? null) !== (atual.responsavel_id ?? null)) {
      db.prepare(`UPDATE tarefas SET responsavel_id = ? WHERE empresa_id = ? AND status IN ('PENDENTE','ANDAMENTO') AND (responsavel_id IS ? OR responsavel_id IS NULL)`)
        .run(d.responsavel_id ?? null, id, atual.responsavel_id ?? null);
    }
  })();
  limparTarefasQueNaoSeAplicam(id);
}

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

/** Lista da carteira com os indicadores de cada cliente. */
export function listarCarteira(escritorioId: number, empresas: number[] | null = null, hoje = hojeBr()) {
  const filtro = empresas ? `AND e.id IN (${empresas.map(() => '?').join(',') || 'NULL'})` : '';
  const linhas = db.prepare(`SELECT e.id, e.documento, e.razao_social, e.nome_fantasia, e.regime, e.op_simp_nac, e.situacao, e.responsavel_id, u.nome AS responsavel,
      e.cliente_desde, e.encerrado_em, e.email, e.contato_nome, e.contato_fone, e.cod_municipio, e.uf, e.inscricao_municipal, e.inscricao_estadual, e.cnae,
      e.tem_funcionarios, e.contribuinte_icms, e.contribuinte_iss, e.eh_escritorio, e.observacoes, e.cert_validade,
      e.cep, e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.crc, e.rep_nome, e.rep_cpf, e.rep_rg, e.rep_nacionalidade, e.rep_estado_civil, e.rep_profissao, (e.cert_pfx_enc IS NOT NULL) AS tem_certificado,
      (SELECT COUNT(*) FROM tarefas t WHERE t.empresa_id = e.id AND t.vencimento < ? AND t.status IN ('PENDENTE','ANDAMENTO')) AS atrasadas,
      (SELECT MIN(t.vencimento) FROM tarefas t WHERE t.empresa_id = e.id AND t.vencimento >= ? AND t.status IN ('PENDENTE','ANDAMENTO')) AS proximo_vencimento,
      (SELECT c.valor FROM contratos c WHERE c.empresa_id = e.id AND c.status = 'ASSINADO' ORDER BY c.inicio DESC LIMIT 1) AS honorario,
      (SELECT c.status FROM contratos c WHERE c.empresa_id = e.id AND c.status != 'ENCERRADO' ORDER BY c.id DESC LIMIT 1) AS contrato_status,
      (SELECT MIN(validade) FROM certificados ce WHERE ce.empresa_id = e.id AND ce.renovado = 0) AS outro_cert_validade
    FROM empresas e LEFT JOIN usuarios u ON u.id = e.responsavel_id
    WHERE e.escritorio_id = ? ${filtro} ORDER BY e.eh_escritorio DESC, (e.situacao = 'ENCERRADO'), COALESCE(e.nome_fantasia, e.razao_social)`).all(hoje, hoje, escritorioId, ...(empresas ?? [])) as any[];
  return linhas.map((c) => {
    const validades = [c.cert_validade?.slice(0, 10), c.outro_cert_validade].filter(Boolean).sort();
    const cert = validades[0] ?? null;
    return { ...c, regime: regimeDe(c), regime_informado: c.regime, tem_funcionarios: !!c.tem_funcionarios, contribuinte_icms: !!c.contribuinte_icms, contribuinte_iss: !!c.contribuinte_iss,
      eh_escritorio: !!c.eh_escritorio, tem_certificado: !!c.tem_certificado, cert_mais_proximo: cert,
      cert_dias: cert ? Math.round((Date.parse(cert) - Date.parse(hoje)) / 864e5) : null };
  });
}

/** Visão geral do escritório: carteira, prazos do mês, certificados e honorários. */
export function visaoGeral(escritorioId: number, mes: string, empresas: number[] | null = null, hoje = hojeBr()) {
  const carteira = listarCarteira(escritorioId, empresas, hoje).filter((c) => !c.eh_escritorio);
  const ativos = carteira.filter((c) => c.situacao === 'ATIVO');
  const porRegime: Record<string, number> = {};
  for (const c of ativos) porRegime[c.regime ?? 'SEM'] = (porRegime[c.regime ?? 'SEM'] ?? 0) + 1;
  const tarefasMes = listarTarefas(escritorioId, { mes, empresas, atrasadas: true }, hoje);
  const certs = listarCertificados(escritorioId, hoje).filter((c) => !empresas || (c.empresa_id && empresas.includes(c.empresa_id)));
  const honorarios = db.prepare(`SELECT COUNT(*) AS contratos, COALESCE(SUM(valor),0) AS total FROM contratos c JOIN empresas e ON e.id = c.empresa_id
    WHERE c.escritorio_id = ? AND c.status = 'ASSINADO' AND e.situacao = 'ATIVO'`).get(escritorioId) as { contratos: number; total: number };
  const esc = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as { id: number } | undefined;
  const emAberto = esc ? db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS total FROM cobrancas WHERE empresa_id = ? AND status IN ('AGUARDANDO_BANCO','EMITIDO') AND vencimento < ?`).get(esc.id, hoje) as { n: number; total: number } : { n: 0, total: 0 };
  return {
    clientes: { ativos: ativos.length, suspensos: carteira.filter((c) => c.situacao === 'SUSPENSO').length, encerrados: carteira.filter((c) => c.situacao === 'ENCERRADO').length, porRegime, semResponsavel: ativos.filter((c) => !c.responsavel_id).length, semContrato: ativos.filter((c) => !c.contrato_status).length },
    tarefas: resumoTarefas(tarefasMes),
    atrasadas: tarefasMes.filter((t) => t.prazo === 'ATRASADA').slice(0, 15),
    proximas: tarefasMes.filter((t) => t.prazo === 'HOJE' || t.prazo === 'EM_BREVE').slice(0, 15),
    certificados: { ...resumoCertificados(certs), lista: certs.filter((c) => ['VENCIDO', 'VENCE_7', 'VENCE_30'].includes(c.situacao)).slice(0, 10) },
    honorarios: { ...honorarios, vencidos: emAberto, escritorioConfigurado: !!esc },
    porResponsavel: Object.values(tarefasMes.filter((t) => t.prazo !== 'ENTREGUE' && t.prazo !== 'DISPENSADA').reduce((acc: Record<string, { responsavel: string; abertas: number; atrasadas: number }>, t) => {
      const k = t.responsavel ?? 'Sem responsável';
      acc[k] ??= { responsavel: k, abertas: 0, atrasadas: 0 };
      acc[k].abertas++; if (t.prazo === 'ATRASADA') acc[k].atrasadas++;
      return acc;
    }, {})),
  };
}
