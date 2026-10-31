import { db } from '../db.js';

/**
 * Tela de início: lembretes do dia para o usuário, só do que ele pode ver (pelos módulos liberados e pelas empresas
 * a que tem acesso). Tudo lido do que o Kontor já guarda; nada consulta a Receita.
 */

export interface Lembrete { nivel: 'ATENCAO' | 'PENDENTE' | 'INFO'; texto: string; link: string }

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const mesAnterior = (d: string) => { const [a, m] = d.split('-').map(Number); return new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7); };
const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const plural = (q: number, um: string, varios: string) => `${q} ${q === 1 ? um : varios}`;

export function lembretesDoDia(escritorioId: number, modulos: string[], empresas: number[] | null): Lembrete[] {
  const hoje = hojeBr();
  const filtro = empresas ? `AND e.id IN (${empresas.join(',') || 'NULL'})` : '';
  const l: Lembrete[] = [];
  const pode = (m: string) => modulos.includes(m);

  if (pode('obrigacoes')) {
    const base = `FROM tarefas t JOIN empresas e ON e.id = t.empresa_id WHERE e.escritorio_id = ? AND e.situacao = 'ATIVO' AND t.status IN ('PENDENTE','ANDAMENTO') ${filtro}`;
    const atrasadas = n(`SELECT COUNT(*) AS n ${base} AND t.vencimento < ?`, escritorioId, hoje);
    const hojeV = n(`SELECT COUNT(*) AS n ${base} AND t.vencimento = ?`, escritorioId, hoje);
    const breve = n(`SELECT COUNT(*) AS n ${base} AND t.vencimento > ? AND t.vencimento <= ?`, escritorioId, hoje, somaDias(hoje, 3));
    if (atrasadas) l.push({ nivel: 'ATENCAO', texto: `${plural(atrasadas, 'obrigação atrasada', 'obrigações atrasadas')}.`, link: '#/obrigacoes' });
    if (hojeV) l.push({ nivel: 'PENDENTE', texto: `${plural(hojeV, 'obrigação vence', 'obrigações vencem')} hoje.`, link: '#/obrigacoes' });
    if (breve) l.push({ nivel: 'INFO', texto: `${plural(breve, 'obrigação vence', 'obrigações vencem')} nos próximos 3 dias.`, link: '#/obrigacoes' });
  }
  if (pode('certificados')) {
    const ate = somaDias(hoje, 30);
    const cert = n(`SELECT COUNT(*) AS n FROM certificados c JOIN empresas e ON e.id = c.empresa_id WHERE c.escritorio_id = ? AND c.renovado = 0 AND e.situacao = 'ATIVO' AND c.validade <= ? ${filtro}`, escritorioId, ate)
      + n(`SELECT COUNT(*) AS n FROM empresas e WHERE e.escritorio_id = ? AND e.situacao = 'ATIVO' AND e.cert_pfx_enc IS NOT NULL AND substr(e.cert_validade,1,10) <= ? ${filtro}`, escritorioId, ate);
    if (cert) l.push({ nivel: 'PENDENTE', texto: `${plural(cert, 'certificado ou procuração vencido ou vencendo', 'certificados e procurações vencidos ou vencendo')} em até 30 dias.`, link: '#/certificados' });
  }
  if (pode('controle')) {
    const mes = mesAnterior(hoje);
    const naoEnviados = (tipo: string) => n(`SELECT COUNT(*) AS n FROM fechamentos f JOIN empresas e ON e.id = f.empresa_id
      WHERE e.escritorio_id = ? AND f.competencia = ? AND f.tipo = ? AND f.guia_pdf IS NOT NULL ${filtro}
        AND NOT EXISTS (SELECT 1 FROM envios_fechamento v WHERE v.empresa_id = f.empresa_id AND v.competencia = f.competencia AND (',' || v.itens || ',') LIKE '%,' || f.tipo || ',%')`, escritorioId, mes, tipo);
    const das = naoEnviados('PGDASD'), darf = naoEnviados('DCTFWEB');
    if (das) l.push({ nivel: 'PENDENTE', texto: `${plural(das, 'DAS gerado ainda não foi enviado', 'DAS gerados ainda não foram enviados')} ao cliente (${mes.slice(5)}/${mes.slice(0, 4)}).`, link: '#/controle' });
    if (darf) l.push({ nivel: 'PENDENTE', texto: `${plural(darf, 'DARF da DCTFWeb ainda não foi enviado', 'DARFs da DCTFWeb ainda não foram enviados')} ao cliente (${mes.slice(5)}/${mes.slice(0, 4)}).`, link: '#/controle' });
    const erroDp = n(`SELECT COUNT(*) AS n FROM dp_envios v JOIN empresas e ON e.id = v.empresa_id WHERE e.escritorio_id = ? AND v.situacao = 'ERRO' AND v.enviado_em >= ? ${filtro}
      AND NOT EXISTS (SELECT 1 FROM dp_envios w WHERE w.empresa_id = v.empresa_id AND w.competencia = v.competencia AND w.situacao = 'ENVIADO' AND w.id > v.id)`, escritorioId, somaDias(hoje, -7));
    if (erroDp) l.push({ nivel: 'ATENCAO', texto: `${plural(erroDp, 'envio automático do DP falhou', 'envios automáticos do DP falharam')} nos últimos 7 dias.`, link: '#/controle' });
  }
  if (pode('situacao')) {
    const relevantes = n(`SELECT COALESCE(SUM(c.relevantes),0) AS n FROM caixa_postal_consultas c JOIN empresas e ON e.id = c.empresa_id
      WHERE e.escritorio_id = ? AND c.id IN (SELECT MAX(id) FROM caixa_postal_consultas GROUP BY empresa_id) ${filtro}`, escritorioId);
    if (relevantes) l.push({ nivel: 'ATENCAO', texto: `${plural(relevantes, 'mensagem relevante não lida', 'mensagens relevantes não lidas')} na caixa postal do e-CAC.`, link: '#/monitor' });
    const parc = n(`SELECT COUNT(*) AS n FROM parcelamentos_consultas p JOIN empresas e ON e.id = p.empresa_id
      WHERE e.escritorio_id = ? AND p.situacao = 'EM_ATRASO' AND p.id IN (SELECT MAX(id) FROM parcelamentos_consultas GROUP BY empresa_id) ${filtro}`, escritorioId);
    if (parc) l.push({ nivel: 'ATENCAO', texto: `${plural(parc, 'cliente com parcela', 'clientes com parcelas')} de parcelamento em atraso.`, link: '#/monitor' });
  }
  if (pode('visao') || pode('situacao')) {
    const sub = n(`SELECT COUNT(*) AS n FROM pgdas_receitas r JOIN empresas e ON e.id = r.empresa_id
      WHERE e.escritorio_id = ? AND e.regime = 'SIMPLES' AND e.situacao = 'ATIVO' AND substr(r.competencia,1,4) = ? AND COALESCE(r.rba,0) + COALESCE(r.rpa,0) >= 2880000
        AND r.competencia = (SELECT MAX(competencia) FROM pgdas_receitas x WHERE x.empresa_id = r.empresa_id) ${filtro}`, escritorioId, hoje.slice(0, 4));
    if (sub) l.push({ nivel: 'ATENCAO', texto: `${plural(sub, 'cliente do Simples está', 'clientes do Simples estão')} perto ou acima do sublimite.`, link: '#/monitor' });
  }
  const ordem = { ATENCAO: 0, PENDENTE: 1, INFO: 2 };
  return l.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}
