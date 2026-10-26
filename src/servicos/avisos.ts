import { z } from 'zod';
import { db } from '../db.js';
import { enviarEmailSimples, ListaEmails } from './email.js';
import { listarTarefas } from './obrigacoes.js';
import { listarCertificados } from './certificados.js';
import { listarContratos } from './honorarios.js';

/**
 * Resumo diário por e-mail: obrigações atrasadas e que vencem nos próximos dias, certificados vencendo e reajustes do mês.
 * Sai uma vez por dia útil (a partir das 7h), só quando há algo a avisar.
 */

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const dataBr = (s: string) => s.slice(0, 10).split('-').reverse().join('/');
const chave = (escritorioId: number) => `avisos_diarios:${escritorioId}`;

export const ConfigAvisos = z.object({ ativo: z.boolean(), emails: z.array(z.string().trim().email()).max(5) })
  .refine((c) => !c.ativo || c.emails.length > 0, { path: ['emails'], message: 'Informe ao menos um e-mail' });

export function configAvisos(escritorioId: number): { ativo: boolean; emails: string[]; ultimo: string | null } {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(chave(escritorioId)) as any)?.valor;
  const c = v ? JSON.parse(v) : {};
  return { ativo: !!c.ativo, emails: c.emails ?? [], ultimo: c.ultimo ?? null };
}

export function salvarAvisos(escritorioId: number, d: z.infer<typeof ConfigAvisos>) {
  if (d.ativo) ListaEmails.parse(d.emails);
  const atual = configAvisos(escritorioId);
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor')
    .run(chave(escritorioId), JSON.stringify({ ativo: d.ativo, emails: d.emails, ultimo: atual.ultimo }));
}

/** Texto do resumo do dia (vazio = nada a avisar). */
export function montarResumo(escritorioId: number, hoje = hojeBr()): string[] {
  const mes = hoje.slice(0, 7);
  const proxMes = new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5), 1)).toISOString().slice(0, 7);
  const tarefas = [...listarTarefas(escritorioId, { mes, atrasadas: true }, hoje), ...listarTarefas(escritorioId, { mes: proxMes }, hoje)];
  const vistas = new Set<number>();
  const unicas = tarefas.filter((t) => !vistas.has(t.id) && vistas.add(t.id));
  const atrasadas = unicas.filter((t) => t.prazo === 'ATRASADA');
  const breve = unicas.filter((t) => t.prazo === 'HOJE' || t.prazo === 'EM_BREVE');
  const certs = listarCertificados(escritorioId, hoje).filter((c) => ['VENCIDO', 'VENCE_7'].includes(c.situacao) || (c.situacao === 'VENCE_30' && [30, 15].includes(c.dias)));
  const reaj = listarContratos(escritorioId, hoje).filter((c) => c.reajuste_pendente);
  const l: string[] = [];
  const linhaT = (t: any) => `• ${dataBr(t.vencimento)} — ${t.codigo} ${t.competencia_rotulo} — ${t.cliente}${t.responsavel ? ` (${t.responsavel})` : ''}`;
  if (atrasadas.length) l.push(`OBRIGAÇÕES ATRASADAS (${atrasadas.length})`, ...atrasadas.slice(0, 40).map(linhaT), atrasadas.length > 40 ? `… e mais ${atrasadas.length - 40}.` : '', '');
  if (breve.length) l.push(`VENCEM HOJE E NOS PRÓXIMOS DIAS (${breve.length})`, ...breve.slice(0, 40).map(linhaT), breve.length > 40 ? `… e mais ${breve.length - 40}.` : '', '');
  if (certs.length) l.push(`CERTIFICADOS E PROCURAÇÕES (${certs.length})`, ...certs.map((c) => `• ${c.tipo} ${c.titular}${c.cliente ? ` — ${c.cliente}` : ''}: ${c.dias < 0 ? `venceu em ${dataBr(c.validade)}` : c.dias === 0 ? 'vence HOJE' : `vence em ${c.dias} dia(s) (${dataBr(c.validade)})`}`), '');
  if (reaj.length) l.push(`REAJUSTES DE HONORÁRIOS DESTE MÊS (${reaj.length})`, ...reaj.map((c) => `• Contrato ${c.numero} — ${c.cliente}`), '');
  return l.filter((x, i, a) => !(x === '' && a[i - 1] === ''));
}

export async function enviarResumo(escritorioId: number, forcar = false, hoje = hojeBr()) {
  const cfg = configAvisos(escritorioId);
  if (!cfg.emails.length) return { enviado: false, motivo: 'Nenhum e-mail configurado.' };
  const linhas = montarResumo(escritorioId, hoje);
  if (!linhas.length && !forcar) return { enviado: false, motivo: 'Nada a avisar hoje.' };
  const corpo = ['Bom dia!', '', ...(linhas.length ? linhas : ['Nenhuma pendência de prazo, certificado ou reajuste para hoje.']), '', 'Resumo automático do Kontor Gestão Contabilidade.'];
  const ok = await enviarEmailSimples(escritorioId, cfg.emails, `Prazos do escritório — ${dataBr(hoje)}`, corpo);
  if (!ok) return { enviado: false, motivo: 'Configure o e-mail do escritório (Configurações > E-mail).' };
  db.prepare('UPDATE parametros SET valor = ? WHERE nome = ?').run(JSON.stringify({ ...cfg, ultimo: hoje }), chave(escritorioId));
  return { enviado: true, motivo: null };
}

/** Chamado de tempos em tempos pelo servidor. */
export async function avisosAutomaticos(agora = new Date()) {
  const br = new Date(agora.getTime() - 3 * 3600e3);
  const hoje = br.toISOString().slice(0, 10);
  if (br.getUTCHours() < 7 || [0, 6].includes(br.getUTCDay())) return;
  for (const { id } of db.prepare('SELECT id FROM escritorios').all() as { id: number }[]) {
    const cfg = configAvisos(id);
    if (!cfg.ativo || cfg.ultimo === hoje) continue;
    try { await enviarResumo(id, false, hoje); } catch { continue; /* falha de envio: tenta de novo na próxima rodada */ }
    // registra o dia mesmo sem nada a enviar, para não montar o resumo de novo a cada rodada
    const atual = configAvisos(id);
    if (atual.ultimo !== hoje) db.prepare('UPDATE parametros SET valor = ? WHERE nome = ?').run(JSON.stringify({ ...atual, ultimo: hoje }), chave(id));
  }
}
