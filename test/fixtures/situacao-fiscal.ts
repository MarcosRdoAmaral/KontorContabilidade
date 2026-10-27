import PDFDocument from 'pdfkit';

/** PDF com o mesmo jeito do Relatório de Situação Fiscal (uma informação por linha, colunas na mesma altura). */
export function relatorioPdf(linhas: (string | string[])[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const partes: Buffer[] = [];
    doc.on('data', (b) => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.font('Helvetica').fontSize(7);
    let y = 40;
    for (const l of linhas) {
      if (y > 780) { doc.addPage(); y = 40; doc.text('Página 2 de 2', 30, 20); }
      if (Array.isArray(l)) { let x = 30; for (const c of l) { doc.text(c, x, y, { lineBreak: false }); x += Math.max(48, c.length * 3.6 + 8); } }
      else doc.text(l, 30, y, { lineBreak: false });
      y += 12;
    }
    doc.end();
  });
}

export const COM_PENDENCIAS: (string | string[])[] = [
  'MINISTÉRIO DA FAZENDA', 'SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL', 'INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO', '27/10/2026 13:10:05',
  'Por meio do e-CAC - CNPJ do certificado: 06.990.590/0001-23', 'CNPJ: 11.222.333 - PADARIA BOA LTDA', 'Dados Cadastrais da Matriz', 'Situação: ATIVA',
  'Certidão Emitida', 'Tipo: Positiva com efeitos de Negativa', 'Diagnóstico Fiscal na Receita Federal',
  'Pendência - Débito (SIEF)', 'CNPJ: 11.222.333/0001-81',
  ['Receita', 'PA/Exerc.', 'Dt. Vcto', 'Vl.Original', 'Sdo.Devedor', 'Multa', 'Juros', 'Sdo.Dev.Cons.', 'Situação'],
  ['1082-01 - CP-SEGURADOS', '06/2026', '20/07/2026', '1.234,56', '1.234,56', '246,91', '45,10', '1.526,57', 'DEVEDOR'],
  ['2172-01 - COFINS', '08/2026', '25/09/2026', '980,00', '980,00', '19,60', '9,80', '1.009,40', 'DEVEDOR'],
  'Pendência - Omissão de DCTF (SIEF)', 'CNPJ: 11.222.333/0001-81', ['DCTF Mensal', 'PA 07/2026'],
  'Diagnóstico Fiscal na Procuradoria-Geral da Fazenda Nacional',
  'Pendência - Inscrição (SIDA)', ['Inscrição', 'Receita', 'Inscrito em', 'Ajuizamento', 'Processo', 'Situação'],
  ['91.6.25.012345-67', 'IRPJ', '15/03/2025', '10880.123456/2024-11', '5.432,10', 'ATIVA EM COBRANÇA'],
  'Débito com Exigibilidade Suspensa (SIEF)', ['5952-01 - CSRF', '01/2026', '20/02/2026', '300,00', '300,00', 'SUSPENSO - LIMINAR'],
  'Final do Relatório',
];
export const REGULAR = ['MINISTÉRIO DA FAZENDA', 'CNPJ: 45.723.174 - ALFA ENGENHARIA', 'Certidão Emitida', 'Tipo: Negativa', 'Diagnóstico Fiscal na Receita Federal e na Procuradoria-Geral da Fazenda Nacional',
  'Não foram detectadas pendências/exigibilidades suspensas nos controles da Receita Federal e da Procuradoria-Geral da Fazenda Nacional.', 'Final do Relatório'];

