import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

/**
 * Modelos dos e-mails que o Kontor manda aos clientes. Cada um tem assunto e texto editáveis, com campos automáticos
 * entre chaves duplas ({{cliente}}, {{valor}}...). Regras simples, para qualquer pessoa usar:
 *  - linha em branco separa parágrafos;
 *  - **texto** sai em negrito;
 *  - campo de lista (ex.: {{guias}}) sozinho na linha vira um quadro com os itens;
 *  - se um campo estiver vazio para aquele envio, a linha em que ele está não é enviada.
 * Sem personalização, vale o texto sugerido (que pode ser restaurado a qualquer momento).
 */

export interface ItemLista { rotulo: string; valor?: string | null; detalhe?: string | null }
export type Valor = string | number | null | undefined | ItemLista[];
export type Variaveis = Record<string, Valor>;
interface Campo { nome: string; descricao: string; exemplo: Valor; lista?: boolean }
interface Modelo { chave: string; grupo: string; nome: string; descricao: string; campos: Campo[]; assunto: string; corpo: string }

const COMUNS: Campo[] = [
  { nome: 'saudacao', descricao: 'Olá, com o nome do contato quando houver', exemplo: 'Olá, Ana!' },
  { nome: 'contato', descricao: 'Nome do contato do cliente', exemplo: 'Ana' },
  { nome: 'cliente', descricao: 'Nome do cliente (fantasia ou razão social)', exemplo: 'Padaria Pão Dourado' },
  { nome: 'razao_social', descricao: 'Razão social do cliente', exemplo: 'Padaria Pão Dourado Ltda' },
  { nome: 'cnpj', descricao: 'CNPJ ou CPF do cliente', exemplo: '11.222.333/0001-81' },
  { nome: 'escritorio', descricao: 'Nome do escritório', exemplo: 'Ciclo Assessoria Contábil' },
];
const COMPETENCIA: Campo[] = [
  { nome: 'competencia', descricao: 'Competência (MM/AAAA)', exemplo: '10/2026' },
  { nome: 'mes', descricao: 'Mês por extenso', exemplo: 'outubro de 2026' },
];
const guiaEx: ItemLista[] = [{ rotulo: 'DAS — Simples Nacional', valor: 'R$ 580,00', detalhe: 'Vencimento 20/11/2026' }];

export const MODELOS: Modelo[] = [
  {
    chave: 'das', grupo: 'Fiscal e departamento pessoal', nome: 'DAS do Simples Nacional', descricao: 'Guia do Simples enviada pelo Controle mensal (aba Fiscal).',
    campos: [...COMUNS, ...COMPETENCIA, { nome: 'guias', descricao: 'Quadro com a guia, o valor e o vencimento', exemplo: guiaEx, lista: true },
      { nome: 'valor', descricao: 'Valor da guia', exemplo: 'R$ 580,00' }, { nome: 'vencimento', descricao: 'Vencimento da guia', exemplo: '20/11/2026' }],
    assunto: 'DAS do Simples Nacional {{competencia}} | {{cliente}}',
    corpo: `{{saudacao}}

Segue em anexo a guia do Simples Nacional (DAS) da **{{cliente}}**, referente a {{mes}}.

{{guias}}

O pagamento pode ser feito pelo aplicativo do seu banco, com o código de barras ou o QR Code Pix da guia. Pagando até o vencimento, você evita multa e juros.

Se o pagamento já estiver programado, é só desconsiderar este lembrete. Qualquer dúvida, responda este e-mail: estamos à disposição.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'darf', grupo: 'Fiscal e departamento pessoal', nome: 'DARF previdenciário (DCTFWeb)', descricao: 'DARF da DCTFWeb enviado pelo Controle mensal (aba Departamento pessoal).',
    campos: [...COMUNS, ...COMPETENCIA, { nome: 'guias', descricao: 'Quadro com o DARF, o valor e o vencimento', exemplo: [{ rotulo: 'DARF — DCTFWeb (INSS)', valor: 'R$ 1.234,56', detalhe: 'Vencimento 20/11/2026' }], lista: true },
      { nome: 'valor', descricao: 'Valor do DARF', exemplo: 'R$ 1.234,56' }, { nome: 'vencimento', descricao: 'Vencimento do DARF', exemplo: '20/11/2026' }],
    assunto: 'DARF previdenciário (INSS) {{competencia}} | {{cliente}}',
    corpo: `{{saudacao}}

Segue em anexo o DARF previdenciário (INSS da folha, apurado na DCTFWeb) da **{{cliente}}**, referente a {{mes}}.

{{guias}}

O pagamento pode ser feito pelo aplicativo do seu banco, com o código de barras ou o QR Code Pix do documento. Pagando até o vencimento, você evita multa e juros.

Qualquer dúvida, responda este e-mail: estamos à disposição.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'das_zero', grupo: 'Fiscal e departamento pessoal', nome: 'Sem DAS no mês', descricao: 'Quando o Simples do mês foi apurado sem valor a pagar (ex.: sem faturamento).',
    campos: [...COMUNS, ...COMPETENCIA],
    assunto: 'Simples Nacional {{competencia}}: sem guia a pagar | {{cliente}}',
    corpo: `{{saudacao}}

A apuração do Simples Nacional da **{{cliente}}** referente a {{mes}} foi entregue e **não há DAS a pagar** neste mês.

Não é preciso fazer nada. Qualquer dúvida, responda este e-mail: estamos à disposição.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'darf_zero', grupo: 'Fiscal e departamento pessoal', nome: 'Sem DARF previdenciário no mês', descricao: 'Quando a DCTFWeb do mês não gerou valor a pagar.',
    campos: [...COMUNS, ...COMPETENCIA],
    assunto: 'DCTFWeb {{competencia}}: sem DARF a pagar | {{cliente}}',
    corpo: `{{saudacao}}

A DCTFWeb da **{{cliente}}** referente a {{mes}} foi transmitida e **não há DARF previdenciário a pagar** neste mês.

Não é preciso fazer nada. Qualquer dúvida, responda este e-mail: estamos à disposição.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'dp', grupo: 'Fiscal e departamento pessoal', nome: 'Documentos do departamento pessoal', descricao: 'Envio automático do DP, quando todos os documentos do mês chegam na pasta do cliente.',
    campos: [...COMUNS, ...COMPETENCIA, { nome: 'documentos', descricao: 'Quadro com os documentos, valores e vencimentos', exemplo: [{ rotulo: 'DARF previdenciária', valor: 'R$ 1.234,56', detalhe: 'Vencimento 20/11/2026' }, { rotulo: 'Guia do FGTS', valor: 'R$ 640,00', detalhe: 'Vencimento 20/11/2026' }, { rotulo: 'Recibo mensal (pró-labore)' }], lista: true }],
    assunto: 'Departamento pessoal {{competencia}} | {{cliente}}',
    corpo: `{{saudacao}}

Os documentos do departamento pessoal da **{{cliente}}** referentes a {{mes}} estão prontos e seguem em anexo:

{{documentos}}

As guias podem ser pagas pelo aplicativo do seu banco, com o código de barras ou o QR Code Pix. Pagando até o vencimento, você evita multa e juros.

Qualquer dúvida, responda este e-mail: estamos à disposição.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'dp_complemento', grupo: 'Fiscal e departamento pessoal', nome: 'Documento do DP enviado depois', descricao: 'Quando um documento chega (ou é substituído) depois do primeiro envio do mês.',
    campos: [...COMUNS, ...COMPETENCIA, { nome: 'documentos', descricao: 'Quadro com os documentos', exemplo: [{ rotulo: 'Boleto do sindicato', valor: 'R$ 85,00', detalhe: 'Vencimento 10/11/2026' }], lista: true }],
    assunto: 'Complemento do departamento pessoal {{competencia}} | {{cliente}}',
    corpo: `{{saudacao}}

Complementando o envio de {{mes}}, segue em anexo mais um documento do departamento pessoal da **{{cliente}}**:

{{documentos}}

Se ele substitui um arquivo enviado antes, considere apenas este.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'nota', grupo: 'Faturamento', nome: 'NFS-e emitida', descricao: 'Nota de serviço enviada ao tomador (na emissão ou pelo faturamento automático).',
    campos: [...COMUNS, { nome: 'numero', descricao: 'Número da NFS-e', exemplo: '128' }, { nome: 'emitente', descricao: 'Quem emitiu a nota', exemplo: 'Ciclo Assessoria Contábil Ltda' },
      { nome: 'valor', descricao: 'Valor do serviço', exemplo: 'R$ 850,00' }, { nome: 'competencia', descricao: 'Competência da nota', exemplo: '01/10/2026' },
      { nome: 'chave', descricao: 'Chave de acesso', exemplo: '42061520...' }, { nome: 'link', descricao: 'Endereço da consulta pública', exemplo: 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=...' },
      { nome: 'boletos', descricao: 'Quadro com os boletos (quando vão junto)', exemplo: [{ rotulo: 'Boleto', valor: 'R$ 850,00', detalhe: 'Vencimento 10/11/2026 · Linha digitável 23790.00000 00000.000000 00000.000000 1 00000000085000' }], lista: true }],
    assunto: 'NFS-e nº {{numero}} | {{emitente}}',
    corpo: `{{saudacao}}

Segue a Nota Fiscal de Serviço eletrônica (NFS-e) **nº {{numero}}**, emitida por {{emitente}}, no valor de **{{valor}}** (competência {{competencia}}).

{{boletos}}

Em anexo estão o PDF (DANFSe) e o arquivo XML da nota. Você também pode consultá-la em {{link}}

Qualquer dúvida, é só responder este e-mail.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'nota_cancelada', grupo: 'Faturamento', nome: 'NFS-e cancelada', descricao: 'Aviso de cancelamento de nota ao tomador.',
    campos: [...COMUNS, { nome: 'numero', descricao: 'Número da NFS-e', exemplo: '128' }, { nome: 'emitente', descricao: 'Quem emitiu a nota', exemplo: 'Ciclo Assessoria Contábil Ltda' },
      { nome: 'valor', descricao: 'Valor da nota', exemplo: 'R$ 850,00' }, { nome: 'competencia', descricao: 'Competência da nota', exemplo: '01/10/2026' },
      { nome: 'motivo', descricao: 'Motivo do cancelamento', exemplo: 'Erro no valor do serviço' }, { nome: 'chave', descricao: 'Chave de acesso', exemplo: '42061520...' },
      { nome: 'link', descricao: 'Endereço da consulta pública', exemplo: 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=...' }],
    assunto: 'NFS-e nº {{numero}} cancelada | {{emitente}}',
    corpo: `{{saudacao}}

Informamos que a NFS-e **nº {{numero}}**, emitida por {{emitente}} no valor de {{valor}} (competência {{competencia}}), foi **cancelada** e não tem mais validade fiscal.
Motivo: {{motivo}}

Pode desconsiderar o documento anterior. Se uma nova nota for emitida, ela chega em seguida.

Em anexo estão o PDF marcado como cancelado e os XMLs da nota e do cancelamento. Consulta: {{link}}

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'boleto', grupo: 'Faturamento', nome: 'Boleto de cobrança', descricao: 'Boleto enviado sem nota (quando o cliente não recebe NFS-e).',
    campos: [...COMUNS, { nome: 'emitente', descricao: 'Quem emitiu o boleto', exemplo: 'Ciclo Assessoria Contábil Ltda' }, { nome: 'valor', descricao: 'Valor', exemplo: 'R$ 850,00' },
      { nome: 'vencimento', descricao: 'Vencimento', exemplo: '10/11/2026' }, { nome: 'linha_digitavel', descricao: 'Linha digitável', exemplo: '23790.00000 00000.000000 00000.000000 1 00000000085000' }],
    assunto: 'Boleto com vencimento em {{vencimento}} | {{emitente}}',
    corpo: `{{saudacao}}

Segue em anexo o boleto de **{{valor}}**, com vencimento em **{{vencimento}}**, emitido por {{emitente}}.

Se preferir, pague pela linha digitável: {{linha_digitavel}}

Se o pagamento já foi feito, desconsidere esta mensagem. Obrigado pela parceria!

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'debitos', grupo: 'Relacionamento', nome: 'Aviso de débitos em aberto', descricao: 'Aviso ao cliente marcado, depois da consulta à situação fiscal.',
    campos: [...COMUNS, { nome: 'data_consulta', descricao: 'Data da consulta à Receita', exemplo: '28/10/2026' },
      { nome: 'debitos', descricao: 'Quadro com os débitos na Receita e as inscrições em dívida ativa', exemplo: [{ rotulo: 'Simples Nacional — períodos 03/2026, 04/2026', valor: 'R$ 1.980,40', detalhe: 'Receita Federal' }, { rotulo: 'IRPJ: 1 inscrição', detalhe: 'Dívida ativa (PGFN)' }], lista: true },
      { nome: 'total', descricao: 'Total aproximado na Receita, com multa e juros', exemplo: 'R$ 1.980,40' }],
    assunto: 'Débitos em aberto na Receita | {{cliente}}',
    corpo: `{{saudacao}}

Fizemos a consulta da situação fiscal da **{{cliente}}** ({{cnpj}}) em {{data_consulta}} e encontramos débitos em aberto:

{{debitos}}

Total aproximado na Receita, com multa e juros até a data da consulta: **{{total}}**

Enquanto houver débitos, a certidão negativa fica impedida e os valores continuam crescendo com multa e juros. Quando quiser regularizar, conte com a gente: emitimos as guias atualizadas para a data em que você for pagar ou avaliamos um parcelamento.

Um abraço,
{{escritorio}}`,
  },
  {
    chave: 'pacote', grupo: 'Contabilidade', nome: 'Fechamento para a contabilidade', descricao: 'Pacote mensal (ZIP) enviado ao e-mail da contabilidade da empresa.',
    campos: [...COMUNS, ...COMPETENCIA, { nome: 'resumo', descricao: 'Quadro com o que vai no pacote', exemplo: [{ rotulo: 'Notas de serviço emitidas (XML)', valor: '42' }, { rotulo: 'Notas de entrada (XML)', valor: '17' }], lista: true }],
    assunto: 'Fechamento {{competencia}} | {{cliente}}',
    corpo: `Olá!

Segue o fechamento de {{mes}} da **{{razao_social}}** ({{cnpj}}):

{{resumo}}

O pacote completo vai em anexo (ZIP). Qualquer ajuste, é só avisar.

Um abraço,
{{escritorio}}`,
  },
];

const porChave = new Map(MODELOS.map((m) => [m.chave, m]));
const definicao = (chave: string) => { const m = porChave.get(chave); if (!m) throw new ErroNegocio('Modelo de e-mail desconhecido.', 404); return m; };

export function lerModelo(escritorioId: number, chave: string) {
  const m = definicao(chave);
  const r = db.prepare('SELECT assunto, corpo, atualizado_em FROM email_modelos WHERE escritorio_id = ? AND chave = ?').get(escritorioId, chave) as any;
  return { assunto: r?.assunto ?? m.assunto, corpo: r?.corpo ?? m.corpo, personalizado: !!r, atualizado_em: r?.atualizado_em ?? null };
}

export function listarModelos(escritorioId: number) {
  return MODELOS.map((m) => ({ chave: m.chave, grupo: m.grupo, nome: m.nome, descricao: m.descricao, campos: m.campos.map(({ nome, descricao, lista }) => ({ nome, descricao, lista: !!lista })),
    padrao: { assunto: m.assunto, corpo: m.corpo }, ...lerModelo(escritorioId, m.chave) }));
}

export const ModeloEditado = z.object({ assunto: z.string().trim().min(1, 'O assunto não pode ficar vazio.').max(200), corpo: z.string().max(8000).refine((v) => v.trim().length > 0, 'O texto não pode ficar vazio.') });

export function salvarModelo(escritorioId: number, chave: string, d: z.infer<typeof ModeloEditado>) {
  const m = definicao(chave);
  const desconhecidos = camposDesconhecidos(chave, `${d.assunto}\n${d.corpo}`);
  if (desconhecidos.length) throw new ErroNegocio(`Campo que não existe neste e-mail: ${desconhecidos.map((n) => `{{${n}}}`).join(', ')}. Use os campos da lista ao lado.`);
  if (d.assunto === m.assunto && d.corpo === m.corpo) return restaurarModelo(escritorioId, chave);
  db.prepare(`INSERT INTO email_modelos (escritorio_id, chave, assunto, corpo) VALUES (?,?,?,?)
    ON CONFLICT(escritorio_id, chave) DO UPDATE SET assunto = excluded.assunto, corpo = excluded.corpo, atualizado_em = datetime('now')`).run(escritorioId, chave, d.assunto, d.corpo);
  return { ok: true };
}
export function camposDesconhecidos(chave: string, texto: string) {
  const m = definicao(chave);
  return [...new Set([...texto.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((x) => x[1]).filter((n) => !m.campos.some((c) => c.nome === n)))];
}
export function restaurarModelo(escritorioId: number, chave: string) {
  definicao(chave);
  db.prepare('DELETE FROM email_modelos WHERE escritorio_id = ? AND chave = ?').run(escritorioId, chave);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Montagem do e-mail
// ---------------------------------------------------------------------------------------------
const escHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const vazio = (v: Valor) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
const TAG = /\{\{\s*([\w]+)\s*\}\}/g;

/** Texto e HTML a partir do modelo (o do escritório, ou o enviado pela tela para a prévia). */
export function renderizar(escritorioId: number, chave: string, vars: Variaveis, editado?: { assunto: string; corpo: string }) {
  const m = definicao(chave);
  const mod = editado ?? lerModelo(escritorioId, chave);
  const esc = db.prepare('SELECT razao_social, nome_fantasia FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  const nomeEsc = esc?.nome_fantasia || esc?.razao_social || (db.prepare('SELECT nome FROM escritorios WHERE id = ?').get(escritorioId) as any)?.nome || '';
  const v: Variaveis = { escritorio: nomeEsc, ...vars };
  if (vazio(v.saudacao)) v.saudacao = v.contato ? `Olá, ${v.contato}!` : 'Olá!';
  const texto = (s: string) => s.replace(TAG, (_x, n) => { const x = v[n]; return Array.isArray(x) ? '' : String(x ?? ''); });
  const assunto = texto(mod.assunto).replace(/\s+/g, ' ').replace(/^[\s|·—-]+|[\s|·—-]+$/g, '').trim();

  // linhas: some a linha cujo campo está vazio; campo de lista sozinho na linha vira bloco
  type Parte = { tipo: 'p'; linhas: string[] } | { tipo: 'lista'; itens: ItemLista[] };
  const partes: Parte[] = [];
  let atual: string[] = [];
  const fecha = () => { if (atual.length) partes.push({ tipo: 'p', linhas: atual }); atual = []; };
  for (const linha of mod.corpo.replace(/\r/g, '').split('\n')) {
    if (!linha.trim()) { fecha(); continue; }
    const so = /^\s*\{\{\s*([\w]+)\s*\}\}\s*$/.exec(linha);
    if (so && Array.isArray(v[so[1]])) { fecha(); if ((v[so[1]] as ItemLista[]).length) partes.push({ tipo: 'lista', itens: v[so[1]] as ItemLista[] }); continue; }
    const nomes = [...linha.matchAll(TAG)].map((x) => x[1]);
    if (nomes.some((n) => vazio(v[n]))) continue;
    atual.push(texto(linha));
  }
  fecha();

  const linhasTexto: string[] = [];
  for (const p of partes) {
    if (linhasTexto.length) linhasTexto.push('');
    if (p.tipo === 'p') linhasTexto.push(...p.linhas.map((l) => l.replace(/\*\*(.+?)\*\*/g, '$1')));
    else for (const i of p.itens) linhasTexto.push(`• ${i.rotulo}${i.valor ? `: ${i.valor}` : ''}${i.detalhe ? ` · ${i.detalhe}` : ''}`);
  }
  const negrito = (s: string) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb;word-break:break-all">$1</a>');
  const corpoHtml = partes.map((p) => p.tipo === 'p'
    ? `<p style="margin:0 0 16px">${p.linhas.map(negrito).join('<br>')}</p>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;background:#f9fafb">
        ${p.itens.map((i, k) => `<tr><td style="padding:12px 16px;${k ? 'border-top:1px solid #e5e7eb;' : ''}vertical-align:top"><div style="font-weight:600;color:#111827">${escHtml(i.rotulo)}</div>${i.detalhe ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${escHtml(i.detalhe)}</div>` : ''}</td>
          <td style="padding:12px 16px;${k ? 'border-top:1px solid #e5e7eb;' : ''}text-align:right;vertical-align:top;white-space:nowrap;font-weight:700;color:#111827;font-size:16px">${i.valor ? escHtml(i.valor) : ''}</td></tr>`).join('')}
      </table>`).join('');
  const html = `<div style="margin:0;padding:24px 12px;background:#f3f4f6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate">
      <tr><td style="padding:32px 36px 20px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#374151">
        ${corpoHtml}
        <!--assinatura-->
      </td></tr>
    </table>
  </td></tr></table>
</div>`;
  return { assunto, linhas: linhasTexto, html };
}

/** Valores de exemplo, para a prévia e o e-mail de teste. */
export function exemplo(chave: string): Variaveis {
  return Object.fromEntries(definicao(chave).campos.filter((c) => c.nome !== 'escritorio').map((c) => [c.nome, c.exemplo]));
}

// ---------------------------------------------------------------------------------------------
// Campos comuns, montados a partir do cadastro
// ---------------------------------------------------------------------------------------------
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** AAAA-MM → { competencia: 'MM/AAAA', mes: 'outubro de 2026' } */
export const camposMes = (mes: string) => ({ competencia: `${mes.slice(5, 7)}/${mes.slice(0, 4)}`, mes: `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}` });
export const moeda = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const dataBr = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const docFmt = (d: string) => { const x = String(d ?? '').replace(/\D/g, ''); return x.length === 14 ? x.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : x.length === 11 ? x.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : String(d ?? ''); };

/** Nome, razão social, CNPJ e contato do cliente (empresa da carteira). */
export function camposCliente(empresaId: number): Variaveis {
  const e = db.prepare('SELECT razao_social, nome_fantasia, documento, contato_nome FROM empresas WHERE id = ?').get(empresaId) as any;
  if (!e) return {};
  const contato = String(e.contato_nome ?? '').trim().split(/\s+/)[0] || '';
  return { cliente: e.nome_fantasia || e.razao_social, razao_social: e.razao_social, cnpj: docFmt(e.documento), contato: contato ? contato[0].toUpperCase() + contato.slice(1).toLowerCase() : '' };
}
