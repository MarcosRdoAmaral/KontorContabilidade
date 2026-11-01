import PDFDocument from 'pdfkit';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { feitasNoControle, fimDaCompetencia, monitorFiscal, prazoComControle } from './monitor.js';
import { ultimasCaixas, ultimosParcelamentos } from './parcelamentos-caixa.js';
import { situacaoPrazo } from './obrigacoes.js';
import { fgtsNaData } from './fgts.js';
import { COR, MM, brl, cabecalho, dataBr, docFmt, emitenteDoEscritorio, rodapes, secao } from '../pdf/timbrado.js';

/**
 * Relatório consolidado da situação fiscal de um cliente (PDF no papel timbrado do escritório): situação de cada
 * processo, débitos na Receita e na PGFN, parcelamentos, FGTS Digital, caixa postal, obrigações, certificados e
 * faturamento do Simples. Tudo a partir das últimas consultas guardadas no Kontor (nada é consultado na hora).
 */
const ESTADO: Record<string, [string, string]> = {
  EM_DIA: ['Em dia', '#15803d'], PENDENTE: ['Pendente', '#b45309'], ATENCAO: ['Atenção', '#b91c1c'], PROCESSANDO: ['Processando', '#1d4ed8'],
};
const PROC_NOME: Record<string, string> = { PGDAS: 'PGDAS-D (Simples Nacional)', PGMEI: 'PGMEI (MEI)', DCTFWEB: 'DCTFWeb', FGTS: 'FGTS Digital', SITFIS: 'Situação fiscal (Receita e PGFN)', PARC: 'Parcelamentos', CAIXA: 'Caixa postal do e-CAC', CERT: 'Certificados e procurações', OBRIG: 'Demais obrigações' };
const REGIME: Record<string, string> = { SIMPLES: 'Simples Nacional', MEI: 'MEI', PRESUMIDO: 'Lucro Presumido', REAL: 'Lucro Real', ARBITRADO: 'Lucro Arbitrado', IMUNE: 'Imune/isenta' };
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

export function dadosSituacaoCliente(escritorioId: number, empresaId: number) {
  const c = db.prepare(`SELECT e.*, u.nome AS responsavel FROM empresas e LEFT JOIN usuarios u ON u.id = e.responsavel_id WHERE e.id = ? AND e.escritorio_id = ?`).get(empresaId, escritorioId) as any;
  if (!c) throw new ErroNegocio('Cliente não encontrado.', 404);
  const hoje = hojeBr();
  const mon = monitorFiscal(escritorioId, [empresaId]);
  const linha = mon.clientes[0] ?? null;
  const sf = db.prepare("SELECT * FROM situacao_fiscal WHERE empresa_id = ? AND status = 'PRONTA' ORDER BY id DESC LIMIT 1").get(empresaId) as any;
  const resumo = sf?.resumo_json ? JSON.parse(sf.resumo_json) : null;
  const secoes = resumo?.secoes ?? [];
  const debitos = secoes.filter((s: any) => s.tipo === 'PENDENCIA' && s.orgao !== 'PGFN').flatMap((s: any) => s.itens).filter((i: any) => i.tipo === 'DEBITO');
  const porTributo = new Map<string, { nome: string; periodos: string[]; total: number }>();
  for (const i of debitos) {
    const k = `${i.receita ?? ''} ${i.descricao ?? ''}`.trim();
    const g = porTributo.get(k) ?? { nome: [i.receita && i.receita !== 'SN' ? i.receita : '', i.descricao || 'Débito'].filter(Boolean).join(' '), periodos: [], total: 0 };
    if (i.periodo) g.periodos.push(i.periodo); g.total += i.saldo ?? 0; porTributo.set(k, g);
  }
  const inscricoes = secoes.filter((s: any) => s.tipo === 'PENDENCIA' && s.orgao === 'PGFN').flatMap((s: any) => s.itens).filter((i: any) => i.tipo === 'INSCRICAO');
  const fg = fgtsNaData(db.prepare('SELECT * FROM fgts_consultas WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(empresaId) as any, hoje) as any;
  const parc = ultimosParcelamentos([empresaId]).get(empresaId) ?? null;
  const caixa = ultimasCaixas([empresaId]).get(empresaId) ?? null;
  const lt = (db.prepare(`SELECT t.empresa_id, t.status, t.vencimento, t.competencia, o.codigo, o.nome, o.antecedencia FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id
    WHERE t.empresa_id = ? AND t.status IN ('PENDENTE','ANDAMENTO') AND t.vencimento <= ? ORDER BY t.vencimento`).all(empresaId, somaDias(hoje, 30)) as any[]).filter((t) => fimDaCompetencia(t.competencia) <= mon.competencia);
  const feitas = feitasNoControle([empresaId], [...new Set(lt.map((t) => t.competencia))]);
  const tarefas = lt.map((t) => ({ ...t, prazo: prazoComControle(t, feitas, hoje) })).filter((t) => t.prazo !== 'ENTREGUE');
  const certs = [...(db.prepare('SELECT tipo, titular, validade FROM certificados WHERE empresa_id = ? AND renovado = 0 ORDER BY validade').all(empresaId) as any[])
    .map((x) => ({ nome: x.tipo === 'PROCURACAO' ? `Procuração eletrônica${x.titular ? ` (${x.titular})` : ''}` : `Certificado ${x.tipo}${x.titular ? ` (${x.titular})` : ''}`, validade: String(x.validade).slice(0, 10) })),
    ...(c.cert_pfx_enc && c.cert_validade ? [{ nome: 'Certificado A1 enviado ao Kontor', validade: String(c.cert_validade).slice(0, 10) }] : [])];
  const sub = mon.sublimites.clientes.find((x: any) => x.empresa_id === empresaId) ?? null;
  const fgTotal = fg?.situacao === 'EM_ABERTO' ? Number(fg.total ?? 0) : 0;
  const parcAtraso = parc?.situacao === 'EM_ATRASO' ? Number(parc.valor_atrasado ?? 0) : 0;
  return {
    hoje, competencia: mon.competencia as string, cliente: { nome: c.razao_social, fantasia: c.nome_fantasia, documento: c.documento, regime: REGIME[c.regime] ?? c.regime ?? '', responsavel: c.responsavel ?? null },
    geral: linha?.geral ?? null, processos: linha?.processos ?? {}, notificacoes: mon.notificacoes,
    sf: sf ? { consultada: sf.concluida_em, situacao: sf.situacao, total: Number(sf.total_aberto ?? 0), certidao: resumo?.certidao ?? null, certidaoValidade: resumo?.certidaoValidade ?? null,
      tributos: [...porTributo.values()].sort((a, b) => b.total - a.total), inscricoes } : null,
    fgts: fg ?? null, parc, caixa, tarefas, certs, sub,
    totalAberto: Math.round(((sf?.situacao === 'PENDENCIAS' ? Number(sf.total_aberto ?? 0) : 0) + fgTotal + parcAtraso) * 100) / 100,
    componentes: { receita: sf?.situacao === 'PENDENCIAS' ? Number(sf.total_aberto ?? 0) : 0, fgts: fgTotal, parcelas: parcAtraso },
  };
}

export function situacaoClientePdf(escritorioId: number, empresaId: number): Promise<{ pdf: Buffer; nome: string }> {
  const d = dadosSituacaoCliente(escritorioId, empresaId);
  const em = emitenteDoEscritorio(escritorioId);
  return new Promise((ok, falha) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Situação fiscal - ${d.cliente.nome}` } });
    const partes: Buffer[] = []; pdf.on('data', (b) => partes.push(b)); pdf.on('end', () => ok({ pdf: Buffer.concat(partes), nome: `Situacao_Fiscal_${d.cliente.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').slice(0, 40)}_${d.hoje}.pdf` }));
    pdf.on('error', falha);
    const X = 16 * MM, W = pdf.page.width - 2 * X, LIM = pdf.page.height - 20 * MM;
    let y = cabecalho(pdf, em, { titulo: 'Situação fiscal do cliente', subtitulo: `Posição em ${dataBr(d.hoje)} · competência ${d.competencia.slice(5)}/${d.competencia.slice(0, 4)}` });
    const garantir = (h: number) => { if (y + h > LIM) { pdf.addPage({ size: 'A4', margin: 0 }); pdf.rect(0, 0, pdf.page.width, 3 * MM).fill(COR.escuro); pdf.rect(0, 0, 32 * MM, 3 * MM).fill(COR.destaque); y = 12 * MM; } };
    const texto = (t: string, x: number, yy: number, o: any = {}) => pdf.fillColor(o.cor ?? COR.texto).font(o.negrito ? 'Helvetica-Bold' : o.italico ? 'Helvetica-Oblique' : 'Helvetica').fontSize(o.tam ?? 8.5).text(t, x, yy, { width: o.w, align: o.align, lineBreak: o.quebra ?? true });
    const selo = (estado: string | null, x: number, yy: number) => {
      const [rot, cor] = estado ? ESTADO[estado] ?? [estado, COR.cinza] : ['Sem informação', '#9ca3af'];
      pdf.circle(x + 3, yy + 3.3, 2.6).fill(cor); texto(rot, x + 9, yy, { cor, negrito: true, tam: 8.3, quebra: false });
    };
    /** Tabela simples: cabeçalho em faixa clara com linha vermelha (como no demonstrativo). */
    const tabela = (cols: { nome: string; w: number; align?: 'left' | 'right' }[], linhas: string[][], vazio: string) => {
      garantir(16 * MM);
      pdf.rect(X, y, W, 6.5 * MM).fill(COR.claro);
      pdf.moveTo(X, y + 6.5 * MM).lineTo(X + W, y + 6.5 * MM).lineWidth(1).stroke(COR.destaque);
      let x = X; for (const c of cols) { texto(c.nome, x + 3, y + 2 * MM, { negrito: true, tam: 7.8, w: c.w * W - 6, align: c.align, quebra: false }); x += c.w * W; }
      y += 6.5 * MM + 1.5;
      if (!linhas.length) { texto(vazio, X + 3, y + 2, { cor: COR.cinza, italico: true }); y = pdf.y + 4 * MM; return; }
      for (const l of linhas) {
        pdf.font('Helvetica').fontSize(8);
        const h = Math.max(...l.map((v, i) => pdf.heightOfString(v, { width: cols[i].w * W - 6 }))) + 4.5;
        garantir(h + 2);
        x = X; l.forEach((v, i) => { texto(v, x + 3, y + 2.2, { w: cols[i].w * W - 6, align: cols[i].align, tam: 8 }); x += cols[i].w * W; });
        y += h; pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.4).stroke(COR.linha);
      }
      y += 5 * MM;
    };

    // cliente e situação geral
    const hCli = 24 * MM;
    pdf.rect(X, y, W, hCli).fillAndStroke(COR.fundo, COR.linha);
    texto('CLIENTE', X + 4 * MM, y + 3.5 * MM, { cor: COR.destaque, negrito: true, tam: 8 });
    texto('SITUAÇÃO GERAL', X + W - 54 * MM, y + 3.5 * MM, { cor: COR.destaque, negrito: true, tam: 8, w: 50 * MM, align: 'right' });
    texto(d.cliente.nome, X + 4 * MM, y + 8.5 * MM, { negrito: true, tam: 10, w: W - 64 * MM });
    texto([`${String(d.cliente.documento).replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ'}: ${docFmt(d.cliente.documento)}`, d.cliente.regime, d.cliente.responsavel ? `Responsável: ${d.cliente.responsavel}` : ''].filter(Boolean).join('  ·  '), X + 4 * MM, pdf.y + 1, { cor: '#333', tam: 8, w: W - 64 * MM });
    const [rotG, corG] = d.geral ? ESTADO[d.geral] ?? [d.geral, COR.cinza] : ['Sem informação', COR.cinza];
    texto(rotG.toUpperCase(), X + W - 64 * MM, y + 11 * MM, { cor: corG, negrito: true, tam: 15, w: 60 * MM, align: 'right' });
    y += hCli + 6;

    // total em aberto
    pdf.rect(X, y, W, 16 * MM).fill(COR.escuro);
    texto('TOTAL EM ABERTO', X + 5 * MM, y + 3.3 * MM, { cor: '#fff', negrito: true, tam: 9 });
    texto([d.componentes.receita ? `Receita/PGFN ${brl(d.componentes.receita)}` : '', d.componentes.fgts ? `FGTS ${brl(d.componentes.fgts)}` : '', d.componentes.parcelas ? `Parcelas em atraso ${brl(d.componentes.parcelas)}` : ''].filter(Boolean).join('  ·  ') || 'Nenhum valor em aberto nas últimas consultas',
      X + 5 * MM, y + 8.3 * MM, { cor: COR.suave, tam: 7.3, w: W - 75 * MM });
    texto(brl(d.totalAberto), X + W - 85 * MM, y + 4.6 * MM, { cor: '#fff', negrito: true, tam: 17, w: 80 * MM, align: 'right' });
    y += 16 * MM + 6 * MM;

    // resumo por processo
    garantir(24 * MM); y = secao(pdf, 'Resumo por processo', X, y);
    {
      const cols = [{ nome: 'Processo', w: 0.32 }, { nome: 'Situação', w: 0.18 }, { nome: 'O que pede atenção', w: 0.5 }];
      garantir(14 * MM);
      pdf.rect(X, y, W, 6.5 * MM).fill(COR.claro); pdf.moveTo(X, y + 6.5 * MM).lineTo(X + W, y + 6.5 * MM).lineWidth(1).stroke(COR.destaque);
      let x = X; for (const c of cols) { texto(c.nome, x + 3, y + 2 * MM, { negrito: true, tam: 7.8, quebra: false }); x += c.w * W; }
      y += 6.5 * MM + 1.5;
      for (const [k, nome] of Object.entries(PROC_NOME)) {
        const est = (d.processos as any)[k] ?? null;
        const notas = d.notificacoes.filter((n: any) => n.processo === k).slice(0, 3).map((n: any) => `${n.titulo}${n.texto ? ` — ${n.texto}` : ''}`);
        if (!est && !notas.length) continue;
        const det = notas.join('\n') || (est === 'EM_DIA' ? 'Nada pendente.' : est === 'PROCESSANDO' ? 'Consulta em andamento.' : k === 'OBRIG' ? 'Veja as obrigações abaixo.' : 'Veja o detalhe abaixo.');
        pdf.font('Helvetica').fontSize(7.8);
        const h = Math.max(pdf.heightOfString(det, { width: 0.5 * W - 6 }), 9) + 5;
        garantir(h + 2);
        texto(nome, X + 3, y + 2.2, { tam: 8.2, w: 0.32 * W - 6 });
        selo(est, X + 0.32 * W + 3, y + 2.2);
        texto(det, X + 0.5 * W + 3, y + 2.2, { tam: 7.8, w: 0.5 * W - 6, cor: est === 'EM_DIA' || !est ? COR.cinza : COR.texto });
        y += h; pdf.moveTo(X, y).lineTo(X + W, y).lineWidth(0.4).stroke(COR.linha);
      }
      y += 6 * MM;
    }

    // débitos na Receita e PGFN
    garantir(24 * MM); y = secao(pdf, 'Receita Federal e PGFN', X, y);
    if (!d.sf) { texto('Nenhuma consulta da situação fiscal concluída para este cliente.', X, y, { cor: COR.cinza, italico: true }); y = pdf.y + 6 * MM; }
    else {
      texto(`Consulta de ${dataBr(d.sf.consultada)}${d.sf.certidao ? ` · Última certidão: ${d.sf.certidao}${d.sf.certidaoValidade ? `, válida até ${dataBr(d.sf.certidaoValidade)}` : ''}` : ''}${d.sf.situacao === 'REGULAR' ? ' · Sem pendências.' : ''}`, X, y, { cor: COR.cinza, tam: 7.8, w: W });
      y = pdf.y + 2 * MM;
      if (d.sf.situacao === 'PENDENCIAS') {
        tabela([{ nome: 'Tributo', w: 0.42 }, { nome: 'Períodos', w: 0.38 }, { nome: 'Saldo devedor', w: 0.2, align: 'right' }],
          d.sf.tributos.map((t) => [t.nome, t.periodos.slice(0, 8).join(', ') + (t.periodos.length > 8 ? ` e mais ${t.periodos.length - 8}` : ''), brl(t.total)]), 'Nenhum débito na Receita Federal.');
        if (d.sf.inscricoes.length) tabela([{ nome: 'Inscrição em dívida ativa (PGFN)', w: 0.3 }, { nome: 'Tributo', w: 0.4 }, { nome: 'Situação', w: 0.3 }],
          d.sf.inscricoes.slice(0, 30).map((i: any) => [i.inscricao ?? '', [i.receita, i.descricao].filter(Boolean).join(' '), i.situacao ?? '']), '');
      } else y += 3 * MM;
    }

    // parcelamentos
    garantir(24 * MM); y = secao(pdf, 'Parcelamentos', X, y);
    if (!d.parc) { texto('Ainda não consultados.', X, y, { cor: COR.cinza, italico: true }); y = pdf.y + 6 * MM; }
    else {
      const linhas: string[][] = [];
      for (const s of d.parc.detalhe ?? []) {
        for (const p of s.pedidos ?? []) linhas.push([s.nome, `Nº ${p.numero} — ${p.situacao}`, (s.parcelas ?? []).filter((x: any) => x.atrasada).length ? `${(s.parcelas ?? []).filter((x: any) => x.atrasada).length} em atraso: ${brl((s.parcelas ?? []).filter((x: any) => x.atrasada).reduce((t: number, x: any) => t + (x.valor ?? 0), 0))}` : 'Em dia']);
      }
      texto(`Consulta de ${dataBr(d.parc.consultado_em)}`, X, y, { cor: COR.cinza, tam: 7.8 }); y = pdf.y + 2 * MM;
      tabela([{ nome: 'Modalidade', w: 0.35 }, { nome: 'Pedido', w: 0.4 }, { nome: 'Parcelas', w: 0.25, align: 'right' }], linhas, d.parc.situacao === 'SEM_PROCURACAO' ? 'Sem procuração para consultar os parcelamentos.' : 'Nenhum parcelamento.');
    }

    // FGTS
    garantir(24 * MM); y = secao(pdf, 'FGTS Digital', X, y);
    if (!d.fgts) { texto('Ainda não consultado.', X, y, { cor: COR.cinza, italico: true }); y = pdf.y + 6 * MM; }
    else {
      const comps = d.fgts.competencias ?? [];
      texto(`Consulta de ${dataBr(d.fgts.consultado_em)}`, X, y, { cor: COR.cinza, tam: 7.8 }); y = pdf.y + 2 * MM;
      tabela([{ nome: 'Competência', w: 0.3 }, { nome: 'Vencimento', w: 0.2 }, { nome: 'Situação', w: 0.25 }, { nome: 'Valor na data da consulta', w: 0.25, align: 'right' }],
        comps.map((x: any) => [String(x.competencia ?? ''), dataBr(x.vencimento), x.a_vencer ? 'A vencer (não é débito)' : 'Vencida', x.total != null ? brl(x.total) : '—']),
        d.fgts.situacao === 'EM_DIA' ? 'Nenhuma competência em aberto.' : d.fgts.situacao === 'SEM_PROCURACAO' ? 'Sem procuração no FGTS Digital.' : (d.fgts.mensagem ?? 'Sem informação.'));
    }

    // caixa postal
    garantir(24 * MM); y = secao(pdf, 'Caixa postal do e-CAC', X, y);
    if (!d.caixa) { texto('Ainda não consultada.', X, y, { cor: COR.cinza, italico: true }); y = pdf.y + 6 * MM; }
    else {
      texto(`Consulta de ${dataBr(d.caixa.consultado_em)} · ${d.caixa.nao_lidas ?? 0} mensagem(ns) não lida(s)${d.caixa.relevantes ? `, ${d.caixa.relevantes} relevante(s)` : ''}`, X, y, { cor: COR.cinza, tam: 7.8 }); y = pdf.y + 2 * MM;
      tabela([{ nome: 'Enviada', w: 0.14 }, { nome: 'Assunto', w: 0.66 }, { nome: 'Situação', w: 0.2 }],
        (d.caixa.mensagens ?? []).filter((m: any) => !m.lida).slice(0, 12).map((m: any) => [dataBr(m.enviada_em), m.assunto || '(sem assunto)', m.relevante ? 'Não lida · relevante' : 'Não lida']), 'Nenhuma mensagem não lida.');
    }

    // obrigações
    garantir(24 * MM); y = secao(pdf, 'Obrigações atrasadas e dos próximos 30 dias', X, y);
    const PRAZO: Record<string, string> = { ATRASADA: 'Atrasada', HOJE: 'Vence hoje', EM_BREVE: 'Vence em breve', NO_PRAZO: 'No prazo' };
    tabela([{ nome: 'Obrigação', w: 0.5 }, { nome: 'Competência', w: 0.16 }, { nome: 'Vencimento', w: 0.16 }, { nome: 'Situação', w: 0.18 }],
      d.tarefas.slice(0, 40).map((t: any) => [t.nome, /^\d{4}-\d{2}$/.test(t.competencia ?? '') ? `${t.competencia.slice(5)}/${t.competencia.slice(0, 4)}` : t.competencia ?? '', dataBr(t.vencimento), PRAZO[t.prazo] ?? t.prazo]), 'Nenhuma obrigação atrasada ou vencendo nos próximos 30 dias.');

    // certificados
    garantir(24 * MM); y = secao(pdf, 'Certificados e procurações', X, y);
    tabela([{ nome: 'Documento', w: 0.6 }, { nome: 'Validade', w: 0.2 }, { nome: 'Situação', w: 0.2 }],
      d.certs.map((c) => [c.nome, dataBr(c.validade), c.validade < d.hoje ? 'Vencido' : c.validade <= somaDias(d.hoje, 30) ? 'Vence em breve' : 'Válido']), 'Nenhum certificado ou procuração cadastrado.');

    // Simples
    if (d.sub) {
      garantir(24 * MM); y = secao(pdf, 'Simples Nacional — faturamento acumulado', X, y);
      garantir(18 * MM);
      texto(`Acumulado no ano até ${d.sub.competencia.slice(5)}/${d.sub.competencia.slice(0, 4)}: ${brl(d.sub.acumulado)} (${Math.round((d.sub.acumulado / 3_600_000) * 100)}% do sublimite de R$ 3,6 milhões)${d.sub.rbt12 != null ? ` · RBT12: ${brl(d.sub.rbt12)}` : ''}${d.sub.projecao != null ? ` · Projeção para o ano: ${brl(d.sub.projecao)}` : ''}.`, X, y, { w: W, tam: 8.3 });
      y = pdf.y + 1.5 * MM; texto(d.sub.motivo ?? '', X, y, { w: W, tam: 8, cor: COR.cinza }); y = pdf.y + 6 * MM;
    }

    garantir(12 * MM);
    texto('Informações das últimas consultas feitas pelo escritório (datas indicadas em cada parte). Os valores em aberto são atualizados até a data de cada consulta; para pagar, as guias são emitidas com multa e juros até a data do pagamento. Em caso de dúvida, valem os documentos oficiais da Receita Federal, da PGFN e do FGTS Digital.',
      X, y, { cor: COR.cinza, italico: true, tam: 7.3, w: W });
    rodapes(pdf, em);
    pdf.end();
  });
}
