import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { db } from '../db.js';
import type { Usuario } from '../auth.js';
import { ErroNegocio } from './emissao.js';
import { consultarCnpj } from './consulta-cnpj.js';
import { entradaDoItem, registrar } from './agenda.js';
import { faturar } from './faturamento.js';

/**
 * Contratos de prestação de serviços e honorários.
 *
 * O contrato assinado vira faturamento recorrente sem trabalho manual: o cliente da carteira passa a ser um
 * cliente (tomador) da empresa do escritório, com o serviço de honorários e o valor do contrato como serviço padrão
 * e a emissão automática ligada no dia escolhido. A tela "Emissão automática" (empresa do escritório) faz o resto:
 * NFS-e e/ou boleto Ailos, envio por e-mail, cobrança e baixa pelo retorno do banco.
 */

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const fmtDoc = (d?: string | null) => !d ? '' : d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
export const ROTULO_INDICE: Record<string, string> = { IPCA: 'IPCA (IBGE)', IGPM: 'IGP-M (FGV)', INPC: 'INPC (IBGE)', FIXO: 'percentual fixo', NENHUM: 'sem reajuste automático' };

// ---------------------------------------------------------------------------------------------
// Valor por extenso
// ---------------------------------------------------------------------------------------------

const UNI = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEN = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function ate999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CEN[c]);
  if (r < 20) { if (r) partes.push(UNI[r]); }
  else { const d = Math.floor(r / 10), u = r % 10; partes.push(u ? `${DEZ[d]} e ${UNI[u]}` : DEZ[d]); }
  return partes.join(' e ');
}

function inteiroPorExtenso(n: number): string {
  if (n === 0) return 'zero';
  const grupos: [number, string, string][] = [[1e9, 'bilhão', 'bilhões'], [1e6, 'milhão', 'milhões'], [1e3, 'mil', 'mil']];
  const partes: string[] = [];
  let resto = n;
  for (const [base, sing, plur] of grupos) {
    const q = Math.floor(resto / base);
    if (q) { partes.push(base === 1e3 && q === 1 ? 'mil' : `${ate999(q)} ${q === 1 ? sing : plur}`); resto %= base; }
  }
  if (resto) partes.push(ate999(resto));
  // "e" antes do último grupo quando ele é < 100 ou múltiplo de 100
  if (partes.length > 1 && (resto < 100 || resto % 100 === 0) && resto) return partes.slice(0, -1).join(' ') + ' e ' + partes[partes.length - 1];
  return partes.join(' ');
}

export function valorPorExtenso(v: number): string {
  const cents = Math.round(v * 100);
  const reais = Math.floor(cents / 100), cent = cents % 100;
  const r = reais ? `${inteiroPorExtenso(reais)}${reais % 1e6 === 0 && reais >= 1e6 ? ' de' : ''} ${reais === 1 ? 'real' : 'reais'}` : '';
  const c = cent ? `${inteiroPorExtenso(cent)} ${cent === 1 ? 'centavo' : 'centavos'}` : '';
  return [r, c].filter(Boolean).join(' e ') || 'zero reais';
}

// ---------------------------------------------------------------------------------------------
// Modelos de contrato
// ---------------------------------------------------------------------------------------------

export const CAMPOS_MODELO = [
  ['contratante.razao_social', 'Razão social do cliente'], ['contratante.documento', 'CNPJ/CPF do cliente'], ['contratante.responsavel', 'Contato do cliente'],
  ['contratada.razao_social', 'Razão social do escritório'], ['contratada.documento', 'CNPJ do escritório'],
  ['numero', 'Número do contrato'], ['inicio', 'Data de início'], ['vigencia', 'Prazo (determinado ou indeterminado)'], ['valor', 'Honorário mensal'],
  ['valor_extenso', 'Honorário por extenso'], ['dia_vencimento', 'Dia do vencimento'], ['indice', 'Índice de reajuste'], ['mes_reajuste', 'Mês do reajuste'],
  ['decimo_terceiro', 'Cláusula do 13º honorário'], ['escopo', 'Serviços contratados'], ['data', 'Data por extenso'],
] as const;

export const MODELO_PADRAO = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS CONTÁBEIS Nº {{numero}}

CONTRATANTE: {{contratante.razao_social}}, inscrita no CNPJ/CPF sob o nº {{contratante.documento}}.

CONTRATADA: {{contratada.razao_social}}, inscrita no CNPJ sob o nº {{contratada.documento}}.

As partes acima identificadas celebram o presente contrato de prestação de serviços profissionais de contabilidade, que se regerá pelas cláusulas seguintes.

CLÁUSULA 1ª – DO OBJETO
A CONTRATADA prestará à CONTRATANTE os seguintes serviços:
{{escopo}}

Serviços não relacionados acima (como abertura e alteração contratual, certidões, declarações extraordinárias, retificações por falha de informação da CONTRATANTE e consultorias específicas) serão orçados e cobrados à parte.

CLÁUSULA 2ª – DAS OBRIGAÇÕES DA CONTRATANTE
A CONTRATANTE entregará à CONTRATADA, até o dia 5 de cada mês, toda a documentação do mês anterior necessária à execução dos serviços (notas fiscais, extratos bancários, folha de ponto, contratos e demais documentos), responsabilizando-se pela sua veracidade. Atrasos na entrega desobrigam a CONTRATADA pelo cumprimento de prazos e pelas penalidades decorrentes.

CLÁUSULA 3ª – DAS OBRIGAÇÕES DA CONTRATADA
A CONTRATADA executará os serviços com zelo, diligência e observância das normas brasileiras de contabilidade e da legislação vigente, guardando sigilo sobre as informações a que tiver acesso, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018).

CLÁUSULA 4ª – DOS HONORÁRIOS
Pelos serviços, a CONTRATANTE pagará à CONTRATADA honorários mensais de {{valor}} ({{valor_extenso}}), com vencimento no dia {{dia_vencimento}} de cada mês. {{decimo_terceiro}}
O atraso no pagamento implicará multa de 2% e juros de 1% ao mês sobre o valor devido.

CLÁUSULA 5ª – DO REAJUSTE
Os honorários serão reajustados anualmente, no mês de {{mes_reajuste}}, pela variação acumulada do {{indice}} nos doze meses anteriores, ou revistos de comum acordo quando houver alteração significativa no volume de serviços.

CLÁUSULA 6ª – DA VIGÊNCIA E DA RESCISÃO
Este contrato vigora a partir de {{inicio}}, por {{vigencia}}, e poderá ser rescindido por qualquer das partes mediante aviso prévio por escrito de 30 (trinta) dias, período em que os serviços e os honorários permanecem devidos. Na rescisão, a CONTRATADA entregará à CONTRATANTE ou ao novo profissional indicado a documentação sob sua guarda, mediante protocolo.

CLÁUSULA 7ª – DO FORO
Fica eleito o foro da comarca da sede da CONTRATADA para dirimir quaisquer dúvidas oriundas deste contrato.

E, por estarem de acordo, as partes assinam o presente instrumento.

{{data}}`;

export const ESCOPO_PADRAO = `- Escrituração contábil e elaboração das demonstrações contábeis anuais;
- Escrituração fiscal, apuração de tributos e emissão das guias de recolhimento;
- Entrega das obrigações acessórias federais, estaduais e municipais aplicáveis ao regime da CONTRATANTE;
- Departamento pessoal: folha de pagamento, eSocial, FGTS Digital, férias, 13º salário e rescisões, quando houver empregados.`;

export function garantirModeloPadrao(escritorioId: number) {
  if (!db.prepare('SELECT 1 FROM contrato_modelos WHERE escritorio_id = ?').get(escritorioId)) {
    db.prepare('INSERT INTO contrato_modelos (escritorio_id, nome, texto) VALUES (?,?,?)').run(escritorioId, 'Prestação de serviços contábeis (padrão)', MODELO_PADRAO);
  }
}

export const Modelo = z.object({ nome: z.string().trim().min(2).max(120), texto: z.string().trim().min(20).max(60000) });

export function listarModelos(escritorioId: number) {
  garantirModeloPadrao(escritorioId);
  return db.prepare('SELECT id, nome, texto, criado_em FROM contrato_modelos WHERE escritorio_id = ? ORDER BY id').all(escritorioId);
}

export function salvarModelo(escritorioId: number, id: number | null, d: z.infer<typeof Modelo>) {
  if (id == null) return Number(db.prepare('INSERT INTO contrato_modelos (escritorio_id, nome, texto) VALUES (?,?,?)').run(escritorioId, d.nome, d.texto).lastInsertRowid);
  const r = db.prepare('UPDATE contrato_modelos SET nome = ?, texto = ? WHERE id = ? AND escritorio_id = ?').run(d.nome, d.texto, id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Modelo não encontrado.', 404);
  return id;
}

export function excluirModelo(escritorioId: number, id: number) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM contrato_modelos WHERE escritorio_id = ?').get(escritorioId) as any).n <= 1) throw new ErroNegocio('Mantenha ao menos um modelo de contrato.');
  const r = db.prepare('DELETE FROM contrato_modelos WHERE id = ? AND escritorio_id = ?').run(id, escritorioId);
  if (!r.changes) throw new ErroNegocio('Modelo não encontrado.', 404);
}

// ---------------------------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------------------------

export const Contrato = z.object({
  empresa_id: z.number().int().positive(),
  modelo_id: z.number().int().positive().nullish(),
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data de início'),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  valor: z.number().positive('Informe o valor do honorário'),
  dia_emissao: z.number().int().min(1).max(31).default(1),
  dia_vencimento: z.number().int().min(1).max(31).default(10),
  modo_faturamento: z.enum(['NOTA', 'NOTA_BOLETO', 'BOLETO']).default('NOTA_BOLETO'),
  indice: z.enum(['IPCA', 'IGPM', 'INPC', 'FIXO', 'NENHUM']).default('IPCA'),
  percentual_fixo: z.number().min(0).max(100).nullish(),
  mes_reajuste: z.number().int().min(1).max(12).nullish(),
  decimo_terceiro: z.boolean().default(false),
  escopo: z.string().trim().max(10000).nullish(),
}).refine((c) => c.indice !== 'FIXO' || c.percentual_fixo != null, { path: ['percentual_fixo'], message: 'Informe o percentual do reajuste' })
  .refine((c) => !c.fim || c.fim > c.inicio, { path: ['fim'], message: 'O fim precisa ser depois do início' });
export type Contrato = z.infer<typeof Contrato>;

function contratoDoEscritorio(escritorioId: number, id: number) {
  const c = db.prepare('SELECT * FROM contratos WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!c) throw new ErroNegocio('Contrato não encontrado.', 404);
  return c;
}

export function listarContratos(escritorioId: number, hoje = hojeBr()) {
  const linhas = db.prepare(`SELECT c.id, c.empresa_id, c.modelo_id, c.numero, c.inicio, c.fim, c.valor, c.dia_emissao, c.dia_vencimento, c.modo_faturamento, c.indice, c.percentual_fixo,
      c.mes_reajuste, c.decimo_terceiro, c.escopo, c.status, c.assinado_em, c.encerrado_em, c.arquivo_nome, c.tomador_id, c.criado_em,
      COALESCE(e.nome_fantasia, e.razao_social) AS cliente, e.documento, e.situacao AS situacao_cliente,
      (SELECT MAX(r.data) FROM reajustes r WHERE r.contrato_id = c.id) AS ultimo_reajuste
    FROM contratos c JOIN empresas e ON e.id = c.empresa_id WHERE c.escritorio_id = ? ORDER BY (c.status = 'ENCERRADO'), cliente, c.numero DESC`).all(escritorioId) as any[];
  return linhas.map((c) => ({ ...c, decimo_terceiro: !!c.decimo_terceiro, reajuste_pendente: reajustePendente(c, hoje) }));
}

/** O contrato chegou ao mês de reajuste e ainda não foi reajustado nos últimos 11 meses? */
export function reajustePendente(c: { status: string; indice: string; inicio: string; mes_reajuste: number | null; ultimo_reajuste?: string | null }, hoje = hojeBr()): boolean {
  if (c.status !== 'ASSINADO' || c.indice === 'NENHUM') return false;
  const mesReaj = c.mes_reajuste ?? Number(c.inicio.slice(5, 7));
  const [a, m] = hoje.split('-').map(Number);
  if (m !== mesReaj) return false;
  if (c.inicio > `${a - 1}-${String(m).padStart(2, '0')}-31`) return false; // ainda não fez 12 meses
  const haOnzeMeses = new Date(Date.parse(hoje) - 300 * 864e5).toISOString().slice(0, 10);
  return !c.ultimo_reajuste || c.ultimo_reajuste < haOnzeMeses;
}

export function criarContrato(escritorioId: number, d: Contrato) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ? AND escritorio_id = ?').get(d.empresa_id, escritorioId)) throw new ErroNegocio('Cliente não encontrado.', 404);
  if (d.modelo_id && !db.prepare('SELECT 1 FROM contrato_modelos WHERE id = ? AND escritorio_id = ?').get(d.modelo_id, escritorioId)) throw new ErroNegocio('Modelo não encontrado.');
  return db.transaction(() => {
    const numero = ((db.prepare('SELECT MAX(numero) AS n FROM contratos WHERE escritorio_id = ?').get(escritorioId) as any).n ?? 0) + 1;
    const r = db.prepare(`INSERT INTO contratos (escritorio_id, empresa_id, modelo_id, numero, inicio, fim, valor, dia_emissao, dia_vencimento, modo_faturamento, indice, percentual_fixo, mes_reajuste, decimo_terceiro, escopo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(escritorioId, d.empresa_id, d.modelo_id ?? null, numero, d.inicio, d.fim ?? null, d.valor, d.dia_emissao, d.dia_vencimento, d.modo_faturamento,
      d.indice, d.indice === 'FIXO' ? d.percentual_fixo ?? null : null, d.mes_reajuste ?? Number(d.inicio.slice(5, 7)), d.decimo_terceiro ? 1 : 0, d.escopo ?? ESCOPO_PADRAO);
    return { id: Number(r.lastInsertRowid), numero };
  })();
}

export async function editarContrato(escritorioId: number, id: number, d: Contrato) {
  const c = contratoDoEscritorio(escritorioId, id);
  if (c.status === 'ENCERRADO') throw new ErroNegocio('Contrato encerrado não pode ser alterado.');
  if (d.empresa_id !== c.empresa_id) throw new ErroNegocio('O cliente do contrato não pode ser trocado. Crie um novo contrato.');
  db.prepare(`UPDATE contratos SET modelo_id=?, inicio=?, fim=?, valor=?, dia_emissao=?, dia_vencimento=?, modo_faturamento=?, indice=?, percentual_fixo=?, mes_reajuste=?, decimo_terceiro=?, escopo=? WHERE id = ?`)
    .run(d.modelo_id ?? null, d.inicio, d.fim ?? null, d.valor, d.dia_emissao, d.dia_vencimento, d.modo_faturamento, d.indice, d.indice === 'FIXO' ? d.percentual_fixo ?? null : null,
      d.mes_reajuste ?? Number(d.inicio.slice(5, 7)), d.decimo_terceiro ? 1 : 0, d.escopo ?? null, id);
  if (c.status === 'ASSINADO') return sincronizarFaturamento(escritorioId, id);
  return { avisos: [] as string[] };
}

export function excluirContrato(escritorioId: number, id: number) {
  const c = contratoDoEscritorio(escritorioId, id);
  if (c.status === 'ASSINADO') throw new ErroNegocio('Contrato assinado não é excluído: encerre-o para manter o histórico.');
  db.prepare('DELETE FROM contratos WHERE id = ?').run(id);
}

export async function mudarStatus(escritorioId: number, id: number, status: 'ENVIADO' | 'ASSINADO' | 'ENCERRADO' | 'RASCUNHO', data?: string | null) {
  const c = contratoDoEscritorio(escritorioId, id);
  const dia = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : hojeBr();
  if (c.status === 'ENCERRADO') throw new ErroNegocio('Contrato já encerrado.');
  if (status === 'ASSINADO') {
    const outro = db.prepare(`SELECT numero FROM contratos WHERE empresa_id = ? AND status = 'ASSINADO' AND id != ?`).get(c.empresa_id, id) as any;
    if (outro) throw new ErroNegocio(`Este cliente já tem o contrato nº ${outro.numero} assinado. Encerre-o antes de assinar o novo.`);
    db.prepare('UPDATE contratos SET status = ?, assinado_em = ? WHERE id = ?').run(status, dia, id);
    return sincronizarFaturamento(escritorioId, id);
  }
  if (status === 'ENCERRADO') {
    db.prepare('UPDATE contratos SET status = ?, encerrado_em = ? WHERE id = ?').run(status, dia, id);
    return desligarFaturamento(id);
  }
  db.prepare('UPDATE contratos SET status = ? WHERE id = ?').run(status, id);
  return { avisos: [] as string[] };
}

export function anexarAssinado(escritorioId: number, id: number, arquivo: Buffer, nome: string) {
  contratoDoEscritorio(escritorioId, id);
  if (arquivo.length > 10 * 1024 * 1024) throw new ErroNegocio('Arquivo acima de 10 MB.');
  const pdf = arquivo.subarray(0, 4).toString() === '%PDF';
  const img = arquivo[0] === 0xff && arquivo[1] === 0xd8 || arquivo.subarray(1, 4).toString() === 'PNG';
  if (!pdf && !img) throw new ErroNegocio('Envie o contrato assinado em PDF, JPG ou PNG.');
  db.prepare('UPDATE contratos SET arquivo_assinado = ?, arquivo_nome = ? WHERE id = ?').run(arquivo, nome.replace(/[^\w.\- ]+/g, '_').slice(0, 120), id);
}

export function arquivoAssinado(escritorioId: number, id: number) {
  const c = db.prepare('SELECT arquivo_assinado, arquivo_nome FROM contratos WHERE id = ? AND escritorio_id = ?').get(id, escritorioId) as any;
  if (!c?.arquivo_assinado) throw new ErroNegocio('Nenhum arquivo assinado anexado.', 404);
  const buf = Buffer.from(c.arquivo_assinado);
  const tipo = buf.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : buf[0] === 0xff ? 'image/jpeg' : 'image/png';
  return { arquivo: buf, nome: c.arquivo_nome || 'contrato-assinado', tipo };
}

// ---------------------------------------------------------------------------------------------
// Texto e PDF do contrato
// ---------------------------------------------------------------------------------------------

export function textoDoContrato(escritorioId: number, id: number): { titulo: string; texto: string } {
  const c = contratoDoEscritorio(escritorioId, id);
  garantirModeloPadrao(escritorioId);
  const modelo = (c.modelo_id ? db.prepare('SELECT texto FROM contrato_modelos WHERE id = ?').get(c.modelo_id) : db.prepare('SELECT texto FROM contrato_modelos WHERE escritorio_id = ? ORDER BY id LIMIT 1').get(escritorioId)) as any;
  const cli = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const esc = db.prepare('SELECT * FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  const escNome = esc?.razao_social ?? (db.prepare('SELECT nome FROM escritorios WHERE id = ?').get(escritorioId) as any)?.nome ?? '';
  const hoje = hojeBr();
  const mesReaj = c.mes_reajuste ?? Number(c.inicio.slice(5, 7));
  const indice = c.indice === 'FIXO' ? `percentual fixo de ${String(c.percentual_fixo).replace('.', ',')}%` : c.indice === 'NENHUM' ? 'índice que as partes vierem a acordar' : ROTULO_INDICE[c.indice];
  const vals: Record<string, string> = {
    'contratante.razao_social': cli.razao_social, 'contratante.documento': fmtDoc(cli.documento), 'contratante.responsavel': cli.contato_nome ?? '',
    'contratada.razao_social': escNome, 'contratada.documento': fmtDoc(esc?.documento),
    numero: String(c.numero).padStart(4, '0'), inicio: dataBr(c.inicio),
    vigencia: c.fim ? `prazo determinado, até ${dataBr(c.fim)}` : 'prazo indeterminado',
    valor: brl(c.valor), valor_extenso: valorPorExtenso(c.valor), dia_vencimento: String(c.dia_vencimento),
    indice, mes_reajuste: MESES[mesReaj - 1],
    decimo_terceiro: c.decimo_terceiro ? 'No mês de dezembro será devido, além do honorário mensal, um honorário adicional de igual valor (13º honorário), referente aos serviços de encerramento do exercício.' : '',
    escopo: c.escopo || ESCOPO_PADRAO,
    data: `${hoje.slice(8, 10)} de ${MESES[Number(hoje.slice(5, 7)) - 1]} de ${hoje.slice(0, 4)}`,
  };
  const texto = String(modelo?.texto ?? MODELO_PADRAO).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => vals[k] ?? `{{${k}}}`);
  return { titulo: `Contrato nº ${vals.numero} — ${cli.nome_fantasia || cli.razao_social}`, texto };
}

export function pdfDoContrato(escritorioId: number, id: number): Promise<Buffer> {
  const { titulo, texto } = textoDoContrato(escritorioId, id);
  const c = contratoDoEscritorio(escritorioId, id);
  const cli = db.prepare('SELECT razao_social, documento FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const esc = db.prepare('SELECT razao_social, documento FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 64, right: 64 }, info: { Title: titulo } });
    const partes: Buffer[] = [];
    doc.on('data', (b) => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes))); doc.on('error', reject);
    const largura = doc.page.width - 128;
    const blocos = texto.split(/\n{2,}/);
    blocos.forEach((b, i) => {
      const linhas = b.split('\n');
      if (i === 0) { doc.font('Helvetica-Bold').fontSize(13).text(b.trim(), { align: 'center', width: largura }); doc.moveDown(1.2); return; }
      for (const [k, l] of linhas.entries()) {
        const titulo = /^CL[ÁA]USULA\b/i.test(l.trim()) || (/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9ºª\s–\-]+$/.test(l.trim()) && l.trim().length < 70 && k === 0);
        doc.font(titulo ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).text(l.trim(), { align: titulo ? 'left' : 'justify', width: largura, lineGap: 2 });
      }
      doc.moveDown(0.8);
    });
    // assinaturas
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(2.5);
    const y = doc.y, meia = (largura - 40) / 2;
    const assinatura = (x: number, nome: string, docum: string, papel: string) => {
      doc.moveTo(x, y).lineTo(x + meia, y).lineWidth(0.6).stroke();
      doc.font('Helvetica-Bold').fontSize(9.5).text(nome ?? '', x, y + 5, { width: meia, align: 'center' });
      doc.font('Helvetica').fontSize(9).text(`${fmtDoc(docum)}\n${papel}`, x, doc.y, { width: meia, align: 'center' });
    };
    assinatura(64, cli.razao_social, cli.documento, 'CONTRATANTE');
    assinatura(64 + meia + 40, esc?.razao_social ?? 'CONTRATADA', esc?.documento ?? '', 'CONTRATADA');
    doc.end();
  });
}

// ---------------------------------------------------------------------------------------------
// Ligação com o faturamento (empresa do escritório)
// ---------------------------------------------------------------------------------------------

const P_SERVICO = 'honorarios_servico_id';
export function configHonorarios(escritorioId: number) {
  const esc = db.prepare('SELECT id, razao_social, nome_fantasia, documento, cert_pfx_enc IS NOT NULL AS tem_certificado, modo_emissao FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  const servicoId = Number((db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(`${P_SERVICO}:${escritorioId}`) as any)?.valor) || null;
  const servicos = esc ? db.prepare('SELECT id, nome, descricao FROM servicos WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(esc.id) : [];
  const conta = esc ? !!db.prepare('SELECT 1 FROM contas_bancarias WHERE empresa_id = ?').get(esc.id) : false;
  return { escritorio: esc ? { ...esc, tem_certificado: !!esc.tem_certificado } : null, servicoId: servicos.some((s: any) => s.id === servicoId) ? servicoId : null, servicos, contaBancaria: conta };
}

export function salvarConfigHonorarios(escritorioId: number, servicoId: number | null) {
  const esc = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  if (!esc) throw new ErroNegocio('Marque primeiro qual empresa da carteira é o próprio escritório (Carteira > editar > "Esta é a empresa do escritório").');
  if (servicoId && !db.prepare('SELECT 1 FROM servicos WHERE id = ? AND empresa_id = ?').get(servicoId, esc.id)) throw new ErroNegocio('Serviço não encontrado na empresa do escritório.');
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(`${P_SERVICO}:${escritorioId}`, servicoId ? String(servicoId) : null);
}

/** Cria/atualiza o cliente (tomador) na empresa do escritório e liga a emissão automática com o valor do contrato. */
export async function sincronizarFaturamento(escritorioId: number, contratoId: number, buscarCnpj = consultarCnpj): Promise<{ avisos: string[] }> {
  const c = contratoDoEscritorio(escritorioId, contratoId);
  const cfg = configHonorarios(escritorioId);
  const avisos: string[] = [];
  if (!cfg.escritorio) return { avisos: ['O faturamento automático não foi ligado: marque na Carteira qual empresa é o próprio escritório.'] };
  if (!cfg.servicoId) return { avisos: ['O faturamento automático não foi ligado: escolha o serviço de honorários em Contratos e honorários > Configurar faturamento.'] };
  if (cfg.escritorio.id === c.empresa_id) return { avisos: ['O contrato é do próprio escritório: não há faturamento a ligar.'] };
  const cli = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  let tomadorId: number | null = c.tomador_id && db.prepare('SELECT 1 FROM tomadores WHERE id = ? AND empresa_id = ?').get(c.tomador_id, cfg.escritorio.id) ? c.tomador_id : null;
  tomadorId ??= (db.prepare('SELECT id FROM tomadores WHERE empresa_id = ? AND documento = ?').get(cfg.escritorio.id, cli.documento) as any)?.id ?? null;
  const vencTipo = 'DIA_FIXO';
  if (!tomadorId) {
    // endereço vem da Receita (necessário para o boleto e para o grupo IBS/CBS); sem a consulta, o cadastro fica marcado para conferir
    let end: any = null;
    if (cli.documento.length === 14) { try { end = await buscarCnpj(cli.documento); } catch { /* segue sem endereço */ } }
    const r = db.prepare(`INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, inscricao_municipal, email, fone, cep, cod_municipio, logradouro, numero, complemento, bairro, cidade, uf,
        modo_faturamento, vencimento_tipo, vencimento_valor, enviar_email_auto, conferir, conferir_motivo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(cfg.escritorio.id, cli.documento.length === 14 ? 'CNPJ' : 'CPF', cli.documento, cli.razao_social, cli.inscricao_municipal,
      cli.email, cli.contato_fone ?? end?.fone ?? null, end?.cep ?? null, cli.cod_municipio ?? end?.cod_municipio ?? null, end?.logradouro ?? null, end?.numero ?? null, end?.complemento ?? null,
      end?.bairro ?? null, end?.municipio ?? null, cli.uf ?? end?.uf ?? null, c.modo_faturamento, vencTipo, c.dia_vencimento, cli.email ? 1 : 0, end ? 0 : 1,
      end ? null : 'Criado pelo contrato de honorários sem consulta à Receita: confira endereço e e-mail.');
    tomadorId = Number(r.lastInsertRowid);
    if (!end) avisos.push('O cliente foi criado na empresa do escritório sem endereço (a consulta à Receita não respondeu): complete o cadastro em Clientes antes de gerar boleto.');
  } else {
    db.prepare('UPDATE tomadores SET modo_faturamento = ?, vencimento_tipo = ?, vencimento_valor = ? WHERE id = ?').run(c.modo_faturamento, vencTipo, c.dia_vencimento, tomadorId);
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO tomador_servicos (tomador_id, servico_id, valor, descricao, padrao) VALUES (?,?,?,?,1)
      ON CONFLICT(tomador_id, servico_id) DO UPDATE SET valor = excluded.valor`).run(tomadorId, cfg.servicoId, c.valor, null);
    db.prepare('UPDATE tomadores SET agenda_ativa = 1, agenda_dia = ? WHERE id = ?').run(c.dia_emissao, tomadorId);
    db.prepare('UPDATE contratos SET tomador_id = ? WHERE id = ?').run(tomadorId, contratoId);
  })();
  if (!cli.email) avisos.push('O cliente não tem e-mail na carteira: a nota/boleto não será enviada automaticamente.');
  if (c.modo_faturamento !== 'NOTA' && !cfg.contaBancaria) avisos.push('A empresa do escritório ainda não tem os dados bancários do boleto (Empresas > Dados bancários).');
  return { avisos };
}

/** Contrato encerrado: para a emissão automática do honorário (o cliente continua cadastrado, com o histórico). */
export function desligarFaturamento(contratoId: number) {
  const c = db.prepare('SELECT tomador_id, escritorio_id FROM contratos WHERE id = ?').get(contratoId) as any;
  if (!c?.tomador_id) return { avisos: [] as string[] };
  const servicoId = Number((db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(`${P_SERVICO}:${c.escritorio_id}`) as any)?.valor) || null;
  db.transaction(() => {
    if (servicoId) db.prepare('DELETE FROM tomador_servicos WHERE tomador_id = ? AND servico_id = ?').run(c.tomador_id, servicoId);
    if (!db.prepare('SELECT 1 FROM tomador_servicos WHERE tomador_id = ?').get(c.tomador_id)) db.prepare('UPDATE tomadores SET agenda_ativa = 0 WHERE id = ?').run(c.tomador_id);
  })();
  return { avisos: ['A emissão automática do honorário deste cliente foi desligada.'] };
}

// ---------------------------------------------------------------------------------------------
// Reajuste
// ---------------------------------------------------------------------------------------------

const SERIE_BCB: Record<string, number> = { IPCA: 433, IGPM: 189, INPC: 188 };
type Buscar = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/**
 * Variação acumulada do índice nos 12 meses anteriores ao mês do reajuste (série do Banco Central, SGS).
 * Ex.: reajuste em 2026-03 usa de 2025-03 a 2026-02.
 */
export async function acumulado12Meses(indice: string, mesReajuste: string, buscar: Buscar = fetch as any) {
  const serie = SERIE_BCB[indice];
  if (!serie) throw new ErroNegocio('Este índice não tem série automática. Informe o percentual.');
  const [a, m] = mesReajuste.split('-').map(Number);
  const ini = new Date(Date.UTC(a - 1, m - 1, 1)), fim = new Date(Date.UTC(a, m - 1, 0));
  const br = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${br(ini)}&dataFinal=${br(fim)}`;
  let dados: { data: string; valor: string }[];
  try {
    const r = await buscar(url);
    if (!r.ok) throw new Error(String(r.status));
    dados = await r.json();
  } catch { throw new ErroNegocio('Não foi possível consultar o índice no Banco Central agora. Tente de novo ou informe o percentual.', 502); }
  if (!Array.isArray(dados) || dados.length < 12) throw new ErroNegocio(`O Banco Central ainda não publicou os 12 meses do ${ROTULO_INDICE[indice]} até ${br(fim).slice(3)}. Informe o percentual ou tente mais tarde.`);
  const fator = dados.slice(-12).reduce((f, d) => f * (1 + Number(String(d.valor).replace(',', '.')) / 100), 1);
  return { percentual: Math.round((fator - 1) * 10000) / 100, meses: dados.slice(-12).map((d) => ({ mes: d.data.slice(3), valor: Number(String(d.valor).replace(',', '.')) })), fonte: 'Banco Central do Brasil (SGS)' };
}

export async function aplicarReajuste(escritorioId: number, usuarioId: number, id: number, percentual: number, data?: string | null) {
  if (!(percentual > -50 && percentual < 100)) throw new ErroNegocio('Percentual de reajuste inválido.');
  const c = contratoDoEscritorio(escritorioId, id);
  if (c.status !== 'ASSINADO') throw new ErroNegocio('Só contratos assinados são reajustados.');
  const novo = Math.round(c.valor * (1 + percentual / 100) * 100) / 100;
  db.transaction(() => {
    db.prepare('INSERT INTO reajustes (contrato_id, data, indice, percentual, valor_anterior, valor_novo, usuario_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, data ?? hojeBr(), c.indice, percentual, c.valor, novo, usuarioId);
    db.prepare('UPDATE contratos SET valor = ? WHERE id = ?').run(novo, id);
  })();
  const r = await sincronizarFaturamento(escritorioId, id);
  return { valorAnterior: c.valor, valorNovo: novo, avisos: r.avisos };
}

export const historicoReajustes = (escritorioId: number, id: number) => {
  contratoDoEscritorio(escritorioId, id);
  return db.prepare('SELECT r.*, u.nome AS usuario FROM reajustes r LEFT JOIN usuarios u ON u.id = r.usuario_id WHERE r.contrato_id = ? ORDER BY r.data DESC, r.id DESC').all(id);
};

// ---------------------------------------------------------------------------------------------
// 13º honorário
// ---------------------------------------------------------------------------------------------

const comp13 = (ano: number) => `${ano}-13`;

export function listarDecimoTerceiro(escritorioId: number, ano: number) {
  const cfg = configHonorarios(escritorioId);
  return (db.prepare(`SELECT c.id, c.numero, c.valor, c.tomador_id, COALESCE(e.nome_fantasia, e.razao_social) AS cliente,
      ex.status, ex.nota_id, ex.cobranca_id, ex.mensagem
    FROM contratos c JOIN empresas e ON e.id = c.empresa_id
    LEFT JOIN agenda_execucoes ex ON ex.tomador_id = c.tomador_id AND ex.servico_id = ? AND ex.competencia = ?
    WHERE c.escritorio_id = ? AND c.status = 'ASSINADO' AND c.decimo_terceiro = 1 ORDER BY cliente`).all(cfg.servicoId ?? 0, comp13(ano), escritorioId) as any[])
    .map((l) => ({ ...l, status: l.status ?? (l.tomador_id ? 'PRONTA' : 'SEM_FATURAMENTO') }));
}

export async function emitirDecimoTerceiro(u: Usuario, contratoId: number, ano: number) {
  const c = contratoDoEscritorio(u.escritorio_id, contratoId);
  const cfg = configHonorarios(u.escritorio_id);
  if (!c.decimo_terceiro) throw new ErroNegocio('Este contrato não prevê 13º honorário.');
  if (!cfg.escritorio || !cfg.servicoId || !c.tomador_id) throw new ErroNegocio('Ligue o faturamento do contrato antes (configuração dos honorários e contrato assinado).');
  const atual = db.prepare('SELECT status FROM agenda_execucoes WHERE tomador_id = ? AND servico_id = ? AND competencia = ?').get(c.tomador_id, cfg.servicoId, comp13(ano)) as any;
  if (atual?.status === 'EMITIDA') throw new ErroNegocio('O 13º honorário deste ano já foi emitido.');
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(cfg.escritorio.id) as any;
  const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  const serv = db.prepare('SELECT * FROM servicos WHERE id = ?').get(cfg.servicoId) as any;
  const ts = { valor: c.valor, descricao: `${serv.descricao} — 13º honorário ${ano}` };
  const hoje = hojeBr();
  try {
    const r = await faturar(u, entradaDoItem(empresa, tomador, ts, serv, hoje.slice(0, 7), hoje));
    const ok = r.acao === 'BOLETO' ? !!r.cobranca : r.nota?.status === 'AUTORIZADA';
    const msg = ok ? (r.avisos.join(' ') || null) : (r.nota?.erros?.map((e: any) => `${e.codigo} ${e.descricao}`).join('; ') || r.avisos.join(' ') || 'A nota não foi autorizada.');
    registrar(empresa.id, tomador.id, serv.id, comp13(ano), ok ? 'EMITIDA' : 'ERRO', c.valor, r.nota?.id ?? null, r.cobranca?.id ?? null, msg);
    return { status: ok ? 'EMITIDA' : 'ERRO', mensagem: msg };
  } catch (e: any) {
    const msg = String(e?.message ?? 'Falha ao emitir.');
    registrar(empresa.id, tomador.id, serv.id, comp13(ano), 'ERRO', c.valor, null, null, msg);
    return { status: 'ERRO', mensagem: msg };
  }
}

/** Honorários em aberto/vencidos por cliente (cobranças da empresa do escritório). */
export function inadimplencia(escritorioId: number, hoje = hojeBr()) {
  const esc = db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  if (!esc) return [];
  return db.prepare(`SELECT t.id AS tomador_id, t.nome AS cliente, t.documento, COUNT(*) AS boletos, SUM(c.valor) AS total, MIN(c.vencimento) AS mais_antigo
    FROM cobrancas c JOIN tomadores t ON t.id = c.tomador_id
    WHERE c.empresa_id = ? AND c.status IN ('AGUARDANDO_BANCO','EMITIDO') AND c.vencimento < ?
    GROUP BY t.id ORDER BY mais_antigo`).all(esc.id, hoje);
}
