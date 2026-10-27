import PDFDocument from 'pdfkit';

/**
 * Relatórios de situação fiscal FICTÍCIOS no mesmo formato do relatório da Receita/PGFN obtido pelo Integra Contador:
 * cabeçalho repetido em cada página, títulos com sublinhados, débitos do SIEF com "Notificação de lançamento",
 * inscrições da PGFN em várias linhas e, opcionalmente, texto desenhado girado a 90° (como no PDF real).
 */
export function relatorioPdf(linhas: (string | string[])[], opcoes: { girado?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const partes: Buffer[] = [];
    doc.on('data', (b) => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes)));
    const W = 842, POR_PAGINA = 40;
    let pagina = 0, y = 0;
    const novaPagina = () => {
      doc.addPage({ size: 'A4', margin: 0 });
      if (opcoes.girado) doc.rotate(90, { origin: [0, 0] }).translate(0, -595); // texto a 90°, lido "deitado"
      doc.font('Helvetica').fontSize(7);
      pagina++; y = 20;
      for (const c of [['MINISTÉRIO DA ECONOMIA', 'Por meio do Integra Contador'], ['SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL', 'Autor pedido: 06.990.590/0001-23. Contratante: 06.990.590/0001-23'],
        ['PROCURADORIA-GERAL DA FAZENDA NACIONAL', '27/10/2026 16:22:45'], ['INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO'], [`Página: ${pagina}`], ['CNPJ: 11.222.333 - PADARIA BOA LTDA']]) {
        doc.text(c[0], 40, y, { lineBreak: false }); if (c[1]) doc.text(c[1], 480, y, { lineBreak: false }); y += 11;
      }
      y += 6;
    };
    novaPagina();
    let n = 0;
    for (const l of linhas) {
      if (n++ >= POR_PAGINA) { novaPagina(); n = 0; }
      if (Array.isArray(l)) { let x = 12; for (const c of l) { doc.text(c, x, y, { lineBreak: false }); x += Math.max(55, c.length * 3.7 + 10); } }
      else doc.text(l, 12, y, { lineBreak: false, width: W });
      y += 11;
    }
    doc.end();
  });
}

const S = '_'.repeat(60);
const deb = (rec: string, desc: string, pa: string, venc: string, orig: string, sdo: string, multa: string, juros: string, cons: string) => [`${rec} - ${desc}`, pa, venc, orig, sdo, multa, juros, cons, 'DEVEDOR'];

export const COM_PENDENCIAS: (string | string[])[] = [
  `Dados Cadastrais da Matriz ${S}`, 'CNPJ: 11.222.333/0001-81', 'Situação: ATIVA', 'Opção pelo Simples Nacional', ['Inclusão', 'Exclusão'], ['01/01/2016', '31/12/2021'],
  `Sócios e Administradores ${S}`, ['CPF/CNPJ', 'Nome', 'Qualificação'], ['390.533.447-05', 'FULANO DE TAL', 'SÓCIO-ADMINISTRADOR'],
  `Certidão Emitida ${S}`, 'CNPJ: 11.222.333/0001-81', ['Certidão Positiva com Efeitos de Negativa:', '950C.2FBD.1434.F2C2', 'Emissão: 06/04/2026', 'Data de Validade: 03/10/2026'],
  `${S} Diagnóstico Fiscal na Receita Federal ${S}`,
  `Pendência - Débito (SIEF) ${S}`, 'CNPJ: 11.222.333/0001-81',
  ['Receita', 'PA/Exerc.', 'Dt. Vcto', 'Vl. Original', 'Sdo. Devedor', 'Multa', 'Juros', 'Sdo. Dev. Cons.', 'Situação'],
  deb('1345-01', 'MAED - DCTF', '22/04/2024', '01/07/2026', '200,00', '200,00', '0,00', '6,34', '206,34'), '          Notificação de lançamento: 14174877105630',
  deb('1138-01', 'CP-PATRONAL', '07/2026', '20/08/2026', '14.879,99', '4.022,88', '804,57', '83,67', '4.911,12'),
  deb('1176-21', 'CP-TERCEIROS', '2025', '19/12/2025', '9,14', '9,14', '1,82', '1,00', '11,96'),
  `Débito com Exigibilidade Suspensa (SIEF) ${S}`, 'CNPJ: 11.222.333/0001-81',
  ['Receita', 'PA/Exerc.', 'Dt. Vcto', 'Vl.Original', 'Sdo.Devedor', 'Situação'], ['5440-01 - MAED - DCTFWEB', '01/09/2026', '17/11/2026', '507,18', '507,18', 'A VENCER'],
  '          Notificação de lançamento: 50000540074741',
  `Parcelamento com Exigibilidade Suspensa (SIEFPAR) ${S}`, 'CNPJ: 11.222.333/0001-81', ['Parcelamento: 0211.00012.0104553445.26-40', 'Valor Suspenso: 71.447,12'], 'Parcelamento Simplificado',
  `${S} Diagnóstico Fiscal na Procuradoria-Geral da Fazenda Nacional ${S}`,
  `Pendência - Inscrição (SIDA) ${S}`, 'CNPJ: 11.222.333/0001-81', ['Inscrição', 'Receita', 'Inscrito em', 'Ajuizado em', 'Processo', 'Tipo de Devedor'],
  ['91.4.21.019567-04', '1507-SIMPLES', '05/04/2021', '12376.267.430/2021-63', 'DEVEDOR PRINCIPAL'], ['', 'NACIONAL'], '          Situação: ATIVA AJUIZADA',
  ['91.6.26.031468-86', '4493-COFINS', '22/06/2026', '14966.477.348/2026-35', 'DEVEDOR PRINCIPAL'], '          Situação: ATIVA A SER COBRADA',
  S, 'Final do Relatório',
];

export const REGULAR: (string | string[])[] = [`Certidão Emitida ${S}`, 'Certidão Negativa: 1234.5678.9ABC.DEF0 Emissão: 01/10/2026 Data de Validade: 30/03/2027',
  `${S} Diagnóstico Fiscal na Receita Federal e na Procuradoria-Geral da Fazenda Nacional ${S}`,
  'Não foram detectadas pendências/exigibilidades suspensas nos controles da Receita Federal e da Procuradoria-Geral da Fazenda Nacional.', 'Final do Relatório'];
