import PDFDocument from 'pdfkit';
import { db } from '../db.js';
import { monitorFiscal, PROCESSOS } from './monitor.js';
import { situacaoPrazo } from './obrigacoes.js';
import { COR, MM, brl, cabecalho, dataBr, docFmt, emitenteDoEscritorio, rodapes, secao } from '../pdf/timbrado.js';

/**
 * Relatório consolidado de pendências por cliente (toda a carteira, ou os clientes escolhidos no Monitor fiscal):
 * uma linha por cliente com os valores em aberto e a contagem de cada tipo de pendência, e depois o detalhe de cada
 * cliente, no papel timbrado do escritório. Lê só o que já está no Kontor (últimas consultas).
 */
const ESTADO: Record<string, [string, string]> = {
  ATENCAO: ['Atenção', '#b91c1c'], PENDENTE: ['Pendente', '#b45309'], PROCESSANDO: ['Processando', '#1d4ed8'], EM_DIA: ['Em dia', '#15803d'],
};
const PESO: Record<string, number> = { ATENCAO: 3, PENDENTE: 2, PROCESSANDO: 1, EM_DIA: 0 };
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const NOME_PROC = Object.fromEntries(PROCESSOS.map((p) => [p.id, p.nome])) as Record<string, string>;

export function dadosPendencias(escritorioId: number, empresas: number[] | null) {
  const hoje = hojeBr();
  const mon = monitorFiscal(escritorioId, empresas, Infinity);
  const ids = mon.clientes.map((c) => c.empresa_id);
  const em = ids.length ? ids.join(',') : 'NULL';
  const mapa = (sql: string, ...p: any[]) => new Map((db.prepare(sql).all(...p) as any[]).map((r) => [r.empresa_id, r]));
  const sf = mapa(`SELECT empresa_id, situacao, total_aberto FROM situacao_fiscal WHERE id IN (SELECT MAX(id) FROM situacao_fiscal WHERE empresa_id IN (${em}) AND status = 'PRONTA' GROUP BY empresa_id)`);
  const fg = mapa(`SELECT empresa_id, situacao, total FROM fgts_consultas WHERE id IN (SELECT MAX(id) FROM fgts_consultas WHERE empresa_id IN (${em}) GROUP BY empresa_id)`);
  const pc = mapa(`SELECT empresa_id, situacao, qtd_atrasadas, valor_atrasado FROM parcelamentos_consultas WHERE id IN (SELECT MAX(id) FROM parcelamentos_consultas WHERE empresa_id IN (${em}) GROUP BY empresa_id)`);
  const cx = mapa(`SELECT empresa_id, situacao, nao_lidas, relevantes FROM caixa_postal_consultas WHERE id IN (SELECT MAX(id) FROM caixa_postal_consultas WHERE empresa_id IN (${em}) GROUP BY empresa_id)`);
  const resp = new Map((db.prepare(`SELECT e.id, u.nome FROM empresas e LEFT JOIN usuarios u ON u.id = e.responsavel_id WHERE e.id IN (${em})`).all() as any[]).map((r) => [r.id, r.nome]));
  const fimMes = (() => { const [a, m] = hoje.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); })();
  const atrasadas = new Map<number, number>(), noMes = new Map<number, any[]>();
  for (const t of db.prepare(`SELECT t.empresa_id, t.status, t.vencimento, o.nome, o.antecedencia FROM tarefas t JOIN obrigacoes o ON o.id = t.obrigacao_id
    WHERE t.empresa_id IN (${em}) AND t.status IN ('PENDENTE','ANDAMENTO') AND t.vencimento <= ? ORDER BY t.vencimento`).all(fimMes) as any[]) {
    if (situacaoPrazo(t, hoje) === 'ATRASADA') atrasadas.set(t.empresa_id, (atrasadas.get(t.empresa_id) ?? 0) + 1);
    else { const l = noMes.get(t.empresa_id) ?? []; l.push(t); noMes.set(t.empresa_id, l); }
  }
  const notifs = new Map<number, any[]>();
  for (const n of mon.notificacoes) { const l = notifs.get(n.empresa_id) ?? []; l.push(n); notifs.set(n.empresa_id, l); }
  const limite = somaDias(hoje, 30);
  const linhas = mon.clientes.map((c) => {
    const s = sf.get(c.empresa_id), f = fg.get(c.empresa_id), p = pc.get(c.empresa_id), x = cx.get(c.empresa_id);
    const receita = s?.situacao === 'PENDENCIAS' ? Number(s.total_aberto ?? 0) : 0;
    const fgts = f?.situacao === 'EM_ABERTO' ? Number(f.total ?? 0) : 0;
    const parcelas = p?.situacao === 'EM_ATRASO' ? Number(p.valor_atrasado ?? 0) : 0;
    const certs = (notifs.get(c.empresa_id) ?? []).filter((n) => n.processo === 'CERT').length;
    const aEntregar = noMes.get(c.empresa_id) ?? [];
    const itens = [...(notifs.get(c.empresa_id) ?? [])];
    if (aEntregar.length) itens.push({ nivel: 'PENDENTE', processo: 'OBRIG', titulo: `${aEntregar.length} obrigação(ões) a entregar até ${dataBr(fimMes)}`,
      texto: aEntregar.slice(0, 8).map((t) => `${t.nome} (${dataBr(t.vencimento)})`).join(', ') + (aEntregar.length > 8 ? ` e mais ${aEntregar.length - 8}` : ''), data: hoje });
    return {
      empresa_id: c.empresa_id, cliente: c.cliente, documento: c.documento, responsavel: resp.get(c.empresa_id) ?? null, geral: c.geral,
      receita, fgts, parcelas, qtd_parcelas: p?.situacao === 'EM_ATRASO' ? Number(p.qtd_atrasadas ?? 0) : 0,
      obrigacoes: atrasadas.get(c.empresa_id) ?? 0, a_entregar: aEntregar.length, nao_lidas: x?.situacao === 'OK' ? Number(x.nao_lidas ?? 0) : 0, relevantes: x?.situacao === 'OK' ? Number(x.relevantes ?? 0) : 0,
      certificados: certs, total: r2(receita + fgts + parcelas), itens,
    };
  });
  const comPendencia = linhas.filter((l) => l.geral === 'ATENCAO' || l.geral === 'PENDENTE' || l.itens.length)
    .sort((a, b) => (PESO[b.geral ?? ''] ?? 0) - (PESO[a.geral ?? ''] ?? 0) || b.total - a.total || a.cliente.localeCompare(b.cliente));
  const soma = (k: 'receita' | 'fgts' | 'parcelas' | 'total' | 'obrigacoes' | 'a_entregar' | 'nao_lidas' | 'certificados') => r2(comPendencia.reduce((t, l) => t + l[k], 0));
  return {
    hoje, limite, carteira: linhas.length, linhas: comPendencia, semPendencia: linhas.length - comPendencia.length,
    atencao: comPendencia.filter((l) => l.geral === 'ATENCAO').length,
    totais: { receita: soma('receita'), fgts: soma('fgts'), parcelas: soma('parcelas'), total: soma('total'), obrigacoes: soma('obrigacoes'), a_entregar: soma('a_entregar'), nao_lidas: soma('nao_lidas'), certificados: soma('certificados') },
  };
}

export function pendenciasPdf(escritorioId: number, empresas: number[] | null): Promise<{ pdf: Buffer; nome: string }> {
  const d = dadosPendencias(escritorioId, empresas);
  const em = emitenteDoEscritorio(escritorioId);
  return new Promise((ok, falha) => {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, bufferPages: true, info: { Title: 'Pendências por cliente' } });
    const partes: Buffer[] = []; pdf.on('data', (b) => partes.push(b)); pdf.on('error', falha);
    pdf.on('end', () => ok({ pdf: Buffer.concat(partes), nome: `Pendencias_por_cliente_${d.hoje}.pdf` }));
    const X = 16 * MM, W = pdf.page.width - 2 * X, LIM = pdf.page.height - 18 * MM;
    const txt = (t: string, x: number, y: number, o: any = {}) => pdf.fillColor(o.cor ?? COR.texto).font(o.negrito ? 'Helvetica-Bold' : o.italico ? 'Helvetica-Oblique' : 'Helvetica').fontSize(o.tam ?? 8).text(t, x, y, { width: o.w, align: o.align, lineBreak: o.quebra ?? true, ellipsis: o.quebra === false ? true : undefined, height: o.h });
    const titulo = { titulo: 'Pendências por cliente', subtitulo: `Posição em ${dataBr(d.hoje)} · ${d.linhas.length} de ${d.carteira} cliente(s) com pendências`, compacto: true };
    const novaPagina = () => { pdf.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); return cabecalho(pdf, em, titulo); };
    let y = cabecalho(pdf, em, titulo);

    // faixa de totais
    const faixa = [
      ['TOTAL EM ABERTO', brl(d.totais.total)], ['Receita e PGFN', brl(d.totais.receita)], ['FGTS Digital', brl(d.totais.fgts)], ['Parcelas em atraso', brl(d.totais.parcelas)],
      ['Clientes em atenção', String(d.atencao)], ['Obrigações atrasadas', String(d.totais.obrigacoes)],
    ];
    pdf.rect(X, y, W, 15 * MM).fill(COR.escuro);
    const wf = W / faixa.length;
    faixa.forEach(([r, v], i) => {
      txt(r.toUpperCase(), X + i * wf + 4 * MM, y + 3 * MM, { cor: i ? COR.suave : '#fff', negrito: true, tam: 7, w: wf - 6 * MM, quebra: false });
      txt(v, X + i * wf + 4 * MM, y + 7.5 * MM, { cor: '#fff', negrito: true, tam: i ? 11 : 13, w: wf - 6 * MM, quebra: false });
    });
    y += 15 * MM + 6 * MM;

    // resumo: uma linha por cliente
    y = secao(pdf, 'Resumo por cliente', X, y);
    const cols: { n: string; w: number; r?: boolean }[] = [
      { n: 'Cliente', w: 0.21 }, { n: 'Responsável', w: 0.09 }, { n: 'Situação', w: 0.08 }, { n: 'Receita/PGFN', w: 0.1, r: true }, { n: 'FGTS', w: 0.08, r: true },
      { n: 'Parc. em atraso', w: 0.09, r: true }, { n: 'Obrig. atras.', w: 0.07, r: true }, { n: 'A entregar', w: 0.06, r: true }, { n: 'Cx. postal', w: 0.06, r: true }, { n: 'Certif.', w: 0.05, r: true }, { n: 'Total em aberto', w: 0.11, r: true },
    ];
    const cab = () => {
      pdf.rect(X, y, W, 7 * MM).fill(COR.claro); pdf.moveTo(X, y + 7 * MM).lineTo(X + W, y + 7 * MM).lineWidth(1.1).stroke(COR.destaque);
      let x = X; for (const c of cols) { txt(c.n, x + 3, y + 2.4 * MM, { negrito: true, tam: 7.6, w: c.w * W - 6, align: c.r ? 'right' : 'left', quebra: false }); x += c.w * W; }
      y += 7 * MM + 2;
    };
    cab();
    const valor = (v: number) => (v ? brl(v) : '—');
    const qtd = (v: number) => (v ? String(v) : '—');
    d.linhas.forEach((l, i) => {
      if (y + 17 > LIM) { y = novaPagina(); cab(); }
      if (i % 2) pdf.rect(X, y - 1, W, 17).fill('#f6f8fb');
      const [rot, cor] = l.geral ? ESTADO[l.geral] : ['—', COR.cinza];
      const v = [l.cliente, l.responsavel ?? '—', rot, valor(l.receita), valor(l.fgts), l.parcelas ? `${brl(l.parcelas)}` : '—', qtd(l.obrigacoes), qtd(l.a_entregar), l.nao_lidas ? `${l.nao_lidas}${l.relevantes ? ` (${l.relevantes}!)` : ''}` : '—', qtd(l.certificados), valor(l.total)];
      let x = X;
      v.forEach((s, k) => {
        const o: any = { tam: 7.8, w: cols[k].w * W - 6, align: cols[k].r ? 'right' : 'left', quebra: false };
        if (k === 2) { pdf.circle(x + 5, y + 4.6, 2.3).fill(cor); txt(s, x + 10, y + 2, { ...o, w: o.w - 7, cor, negrito: true }); }
        else txt(s, x + 3, y + 2, { ...o, negrito: k === 0 || k === 10 });
        x += cols[k].w * W;
      });
      txt(docFmt(l.documento), X + 3, y + 9.5, { tam: 6.5, cor: COR.cinza, w: cols[0].w * W - 6, quebra: false });
      y += 17; pdf.moveTo(X, y - 1).lineTo(X + W, y - 1).lineWidth(0.4).stroke(COR.linha);
    });
    if (!d.linhas.length) { txt('Nenhum cliente com pendências nas últimas consultas.', X, y + 6, { cor: COR.cinza, italico: true, tam: 10, w: W, align: 'center' }); y += 20; }
    else {
      if (y + 22 > LIM) { y = novaPagina(); }
      y += 3; pdf.rect(X, y, W, 8 * MM).fill(COR.escuro);
      const tot = [`TOTAL (${d.linhas.length})`, '', '', valor(d.totais.receita), valor(d.totais.fgts), valor(d.totais.parcelas), qtd(d.totais.obrigacoes), qtd(d.totais.a_entregar), qtd(d.totais.nao_lidas), qtd(d.totais.certificados), valor(d.totais.total)];
      let x = X; tot.forEach((s, k) => { txt(s, x + 3, y + 2.7 * MM, { cor: '#fff', negrito: true, tam: 8, w: cols[k].w * W - 6, align: cols[k].r ? 'right' : 'left', quebra: false }); x += cols[k].w * W; });
      y += 8 * MM + 3 * MM;
    }
    if (d.semPendencia) { txt(`${d.semPendencia} cliente(s) da seleção sem pendências nas últimas consultas.`, X, y, { cor: COR.cinza, tam: 7.5 }); y = pdf.y + 2; }

    // detalhe por cliente
    if (d.linhas.some((l) => l.itens.length)) {
      if (y + 40 * MM > LIM) y = novaPagina(); else y += 5 * MM;
      y = secao(pdf, 'Detalhe por cliente', X, y);
      for (const l of d.linhas.filter((x) => x.itens.length)) {
        if (y + 9 * MM + 12 > LIM) y = novaPagina();
        const [rot, cor] = l.geral ? ESTADO[l.geral] : ['—', COR.cinza];
        pdf.rect(X, y, W, 7.5 * MM).fill(COR.fundo); pdf.rect(X, y, 1.2 * MM, 7.5 * MM).fill(cor);
        txt(l.cliente, X + 4 * MM, y + 2.2 * MM, { negrito: true, tam: 8.6, cor: COR.escuro, w: W * 0.55, quebra: false });
        txt([docFmt(l.documento), l.responsavel ? `Responsável: ${l.responsavel}` : '', rot, l.total ? `Em aberto ${brl(l.total)}` : ''].filter(Boolean).join('  ·  '), X + W * 0.45, y + 2.4 * MM, { tam: 7.5, cor: COR.cinza, w: W * 0.55 - 4 * MM, align: 'right', quebra: false });
        y += 7.5 * MM + 2;
        for (const n of l.itens) {
          const linha = `${n.titulo}${n.texto ? ` — ${n.texto}` : ''}`;
          pdf.font('Helvetica').fontSize(7.6);
          const h = pdf.heightOfString(linha, { width: W * 0.72 }) + 3;
          if (y + h > LIM) { y = novaPagina(); txt(`${l.cliente} (continuação)`, X, y, { negrito: true, tam: 8, cor: COR.escuro }); y = pdf.y + 2; }
          pdf.circle(X + 5, y + 3.3, 2).fill(ESTADO[n.nivel]?.[1] ?? COR.cinza);
          txt(NOME_PROC[n.processo] ?? n.processo, X + 11, y + 0.8, { tam: 7.4, cor: COR.cinza, negrito: true, w: W * 0.13, quebra: false });
          txt(linha, X + W * 0.15, y + 0.8, { tam: 7.6, w: W * 0.72 });
          txt(dataBr(n.data), X + W * 0.89, y + 0.8, { tam: 7.4, cor: COR.cinza, w: W * 0.11, align: 'right', quebra: false });
          y += h;
        }
        y += 3 * MM;
      }
    }
    if (y + 12 * MM > LIM) y = novaPagina();
    txt('Informações das últimas consultas feitas no Kontor (situação fiscal, FGTS Digital, parcelamentos e caixa postal) e do controle de obrigações. Valores em aberto atualizados até a data de cada consulta. "Obrig. atras." = obrigações atrasadas; "A entregar" = obrigações que vencem até o fim do mês; "Cx. postal" = mensagens não lidas (com "!" as marcadas como relevantes pela Receita); "Certif." = certificados e procurações vencidos ou vencendo em 30 dias.',
      X, y + 2 * MM, { cor: COR.cinza, italico: true, tam: 7, w: W });
    rodapes(pdf, em);
    pdf.end();
  });
}
