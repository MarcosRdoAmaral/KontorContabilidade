import PDFDocument from 'pdfkit';

/**
 * Texto padrão do contrato e o gerador do PDF.
 *
 * O texto do modelo é escrito com marcações simples, uma por linha:
 *   - a primeira linha é o título (centralizado, em negrito);
 *   - "CLÁUSULA ..." vira título de cláusula, com uma linha separadora acima;
 *   - "1. Texto" é item numerado (recuo); "1. Título:" (terminado em dois-pontos) é subtítulo em negrito;
 *   - "- texto" ou "• texto" é marcador (recuo maior);
 *   - "---" desenha uma linha separadora;
 *   - **texto** sai em negrito; linha em branco dá um respiro maior.
 * Os campos {{...}} são trocados pelos dados do cliente e do contrato antes de desenhar.
 */

/** Campo sem informação no cadastro: sai como linha para preencher à mão. */
export const FALTA = '______________________';

export const CAMPOS_MODELO = [
  ['contratante.razao_social', 'Razão social do cliente'], ['contratante.tipo_documento', '“CNPJ” ou “CPF”, conforme o cliente'], ['contratante.documento', 'CNPJ/CPF do cliente'],
  ['contratante.endereco', 'Endereço completo do cliente (rua, nº, bairro, cidade, estado, CEP)'], ['contratante.responsavel', 'Contato do cliente'],
  ['representante.qualificacao', 'Representante legal com nacionalidade, estado civil, profissão, CPF e RG'], ['representante.nome', 'Nome do representante legal'],
  ['representante.cpf', 'CPF do representante'], ['representante.rg', 'RG do representante'],
  ['contratada.razao_social', 'Razão social do escritório'], ['contratada.documento', 'CNPJ do escritório'], ['contratada.endereco', 'Endereço completo do escritório'],
  ['contratada.crc', 'Registro do escritório no CRC'],
  ['numero', 'Número do contrato'], ['inicio', 'Data de início'], ['vigencia', 'Prazo (determinado ou indeterminado)'], ['valor', 'Honorário mensal'],
  ['valor_extenso', 'Honorário por extenso'], ['dia_vencimento', 'Dia do vencimento'], ['dia_vencimento_extenso', 'Dia do vencimento por extenso'],
  ['indice', 'Índice de reajuste'], ['mes_reajuste', 'Mês do reajuste'], ['decimo_terceiro', 'Frase do 13º honorário (vazia se não houver)'],
  ['escopo', 'Serviços contratados (do contrato)'], ['cidade', 'Cidade do escritório (local da assinatura)'], ['foro', 'Comarca do foro (cidade e UF do escritório)'],
  ['data', 'Data por extenso (assinatura ou hoje)'],
] as const;

export const ESCOPO_PADRAO = `1. Serviços Contábeis:
- Escrituração contábil mensal conforme normas brasileiras;
- Elaboração de balancetes, demonstrações contábeis e relatórios gerenciais;
- Apuração de resultados mensais e anuais.
2. Serviços Fiscais:
- Apuração de tributos federais, estaduais e municipais;
- Emissão de guias de recolhimento;
- Elaboração e transmissão de obrigações acessórias (DCTFWeb, EFD, SPED etc.).
3. Serviços Trabalhistas e Previdenciários:
- Cadastramento e admissão de funcionários;
- Elaboração da folha de pagamento e encargos (FGTS, INSS, IRRF);
- Obrigações acessórias como eSocial, FGTS Digital, DCTFWeb e EFD-Reinf.
4. Serviços de Consultoria:
- Orientação sobre planejamento tributário, reorganização societária e compliance;
- Atendimento a fiscalizações e auditorias, mediante agendamento.`;

export const MODELO_PADRAO = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS CONTÁBEIS

**Pelo presente instrumento particular de contrato**, de um lado:
**CONTRATANTE: {{contratante.razao_social}}**, inscrita no {{contratante.tipo_documento}} sob nº {{contratante.documento}}, com sede na {{contratante.endereco}}, neste ato representada por {{representante.qualificacao}}, doravante denominada simplesmente **CONTRATANTE**.
E de outro lado:
**CONTRATADA:** {{contratada.razao_social}}, inscrita no CNPJ sob o nº {{contratada.documento}}, com sede na {{contratada.endereco}}, regularmente registrada no Conselho Regional de Contabilidade (CRC) sob o nº {{contratada.crc}}, doravante denominada **CONTRATADA**.
As partes acima identificadas têm, entre si, justo e acertado o presente **Contrato de Prestação de Serviços Contábeis**, que se regerá pelas cláusulas seguintes:

CLÁUSULA PRIMEIRA – DO OBJETO
O presente contrato tem por objeto a prestação, pela CONTRATADA, dos serviços técnicos de **contabilidade**, **assessoria fiscal**, **trabalhista**, **previdenciária**, **consultoria contábil** e **cumprimento de obrigações acessórias** perante os órgãos públicos competentes, nos termos da legislação vigente e conforme detalhamento abaixo:
{{escopo}}

CLÁUSULA SEGUNDA – DAS OBRIGAÇÕES DA CONTRATADA
A CONTRATADA se compromete a:
1. Prestar os serviços ora contratados com diligência, ética, sigilo profissional e de acordo com as normas legais e técnicas aplicáveis;
2. Cumprir prazos legais e convencionados, desde que a CONTRATANTE envie as informações e documentos no prazo necessário;
3. Manter atualizados os registros contábeis, fiscais e trabalhistas da CONTRATANTE;
4. Informar sobre alterações relevantes na legislação que impactem as obrigações da CONTRATANTE;
5. Guardar sigilo absoluto sobre todos os dados, documentos e informações da CONTRATANTE.

CLÁUSULA TERCEIRA – DAS OBRIGAÇÕES DA CONTRATANTE
A CONTRATANTE se compromete a:
1. Entregar todos os documentos e informações necessárias à prestação dos serviços, com antecedência mínima de 10 dias úteis antes dos prazos legais;
2. Zelar pela veracidade das informações prestadas;
3. Efetuar o pagamento dos honorários conforme cláusula seguinte;
4. Informar eventuais alterações cadastrais, societárias, trabalhistas ou fiscais;
5. Cumprir as recomendações da CONTRATADA, sob pena de eximir a responsabilidade técnica desta.

CLÁUSULA QUARTA – DOS HONORÁRIOS
1. Pelos serviços prestados, a CONTRATANTE pagará à CONTRATADA o valor mensal de {{valor}} ({{valor_extenso}}), com vencimento no dia {{dia_vencimento}} ({{dia_vencimento_extenso}}) de cada mês. {{decimo_terceiro}}
2. O reajuste dos honorários ocorrerá anualmente, no mês de {{mes_reajuste}}, com base no índice {{indice}};
3. Serviços extraordinários ou eventuais (declaração de imposto de renda pessoa física, recálculo de guias, consultorias, auditorias, declaração IBGE, parcelamentos, recuperação de obrigações etc.) não estão incluídos no valor acima e serão cobrados mediante orçamento específico;
4. O atraso no pagamento superior a 05 (cinco) dias implicará multa de 2%, juros de 1% ao mês e correção monetária, além da possibilidade de suspensão dos serviços.

CLÁUSULA QUINTA – DO PRAZO E DA RESCISÃO
1. O presente contrato é firmado por {{vigencia}}, vigorando a partir de {{inicio}};
2. Pode ser rescindido a qualquer tempo por qualquer das partes, mediante aviso por escrito com 30 (trinta) dias de antecedência;
3. A rescisão imediata será admitida no caso de inadimplemento contratual ou quebra de sigilo;
4. No caso de rescisão, será emitido relatório de encerramento das atividades com o repasse de documentos e informações pertinentes.

CLÁUSULA SEXTA – DA CONFIDENCIALIDADE
1. A CONTRATADA se compromete a manter absoluto sigilo sobre todos os dados e documentos da CONTRATANTE, inclusive após o término deste contrato;
2. Fica proibida a divulgação, cessão ou uso das informações para qualquer fim diverso do necessário à execução dos serviços contratados.

CLÁUSULA SÉTIMA – DA RESPONSABILIDADE
1. A CONTRATADA não será responsável por multas ou penalidades decorrentes de atraso na entrega de documentos por parte da CONTRATANTE;
2. A responsabilidade da CONTRATADA está limitada aos serviços sob sua alçada e execução, excluindo decisões ou atos praticados exclusivamente pela CONTRATANTE.

CLÁUSULA OITAVA – DA LEI GERAL DE PROTEÇÃO DE DADOS (LGPD)
1. As partes declaram estar cientes da LGPD (Lei nº 13.709/2018) e comprometem-se a cumprir suas disposições;
2. A CONTRATADA utilizará os dados da CONTRATANTE exclusivamente para fins da execução contratual, observando os princípios da finalidade, necessidade e segurança.

CLÁUSULA NONA – DO FORO
Para dirimir eventuais dúvidas ou controvérsias oriundas deste contrato, fica eleito o foro da comarca de {{foro}}, renunciando as partes a qualquer outro, por mais privilegiado que seja.

---
E, por estarem assim justas e contratadas, firmam o presente instrumento em duas vias de igual teor, juntamente com duas testemunhas.
**{{cidade}}, {{data}}.**`;

/** Modelo e escopo padrão da versão 1.0.0: instalações que nunca os alteraram passam para os novos. */
export const MODELO_PADRAO_V1 = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS CONTÁBEIS Nº {{numero}}

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

export const ESCOPO_PADRAO_V1 = `- Escrituração contábil e elaboração das demonstrações contábeis anuais;
- Escrituração fiscal, apuração de tributos e emissão das guias de recolhimento;
- Entrega das obrigações acessórias federais, estaduais e municipais aplicáveis ao regime da CONTRATANTE;
- Departamento pessoal: folha de pagamento, eSocial, FGTS Digital, férias, 13º salário e rescisões, quando houver empregados.`;

export function preencherModelo(texto: string, vals: Record<string, string>) {
  return texto.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => vals[k] ?? `{{${k}}}`);
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

export interface Parte { nome: string; documento: string }
export interface OpcoesPdf {
  titulo: string;
  texto: string;
  contratante: Parte;
  contratada: Parte;
  testemunhas: boolean;
  /** Imagem (PNG/JPG) desenhada no centro de cada página, com a opacidade indicada (0–1). */
  marca?: { imagem: Buffer; opacidade: number } | null;
}

const M = { esq: 72, dir: 72, topo: 70, base: 64 };
const CORPO = 11;
const GAP = 3.2;

export function gerarPdfContrato(o: OpcoesPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: M.topo, bottom: M.base, left: M.esq, right: M.dir }, info: { Title: o.titulo }, bufferPages: false });
    const partes: Buffer[] = [];
    doc.on('data', (b) => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes))); doc.on('error', reject);
    const W = doc.page.width - M.esq - M.dir;
    const fundoPagina = () => doc.page.height - M.base;
    let pagina = 0;
    let fonte = { nome: 'Helvetica', tam: CORPO };
    const usar = (nome: string, tam = CORPO) => { fonte = { nome, tam }; doc.font(nome).fontSize(tam); };

    const decorar = () => {
      pagina++;
      const x = doc.x, y = doc.y;
      if (o.marca) {
        try {
          const larg = doc.page.width * 0.78, alt = doc.page.height * 0.5;
          doc.save();
          doc.opacity(Math.min(1, Math.max(0.03, o.marca.opacidade)));
          doc.image(o.marca.imagem, (doc.page.width - larg) / 2, (doc.page.height - alt) / 2, { fit: [larg, alt], align: 'center', valign: 'center' });
          doc.restore();
        } catch { o.marca = null; /* imagem inválida: segue sem marca d'água */ }
      }
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(String(pagina), M.esq, 34, { width: W, align: 'right', lineBreak: false });
      doc.fillColor('#000').font(fonte.nome).fontSize(fonte.tam);
      doc.x = x; doc.y = y;
    };
    doc.on('pageAdded', decorar);
    decorar();

    /** Garante espaço na página para `alt` pontos; senão, começa outra. */
    const espaco = (alt: number) => { if (doc.y + alt > fundoPagina()) { doc.addPage(); doc.y = M.topo; } };
    const regua = () => {
      espaco(30);
      doc.moveDown(0.35);
      const y = doc.y;
      doc.save().moveTo(M.esq, y).lineTo(M.esq + W, y).lineWidth(0.7).strokeColor('#b3b3b3').stroke().restore();
      doc.y = y + 10;
    };

    /** Altura do parágrafo, para não dividi-lo entre duas páginas. */
    const altura = (txt: string, larg: number, negrito = false) => {
      doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(fonte.tam);
      const h = doc.heightOfString(txt.replace(/\*\*/g, ''), { width: larg, lineGap: GAP });
      doc.font(fonte.nome).fontSize(fonte.tam);
      return h;
    };

    /** Escreve um parágrafo com trechos **em negrito**, começando em x com a largura dada. */
    const escrever = (txt: string, x: number, larg: number, negrito = false, align: 'left' | 'center' | 'justify' = 'left') => {
      if (altura(txt, larg, negrito) < fundoPagina() - M.topo) espaco(altura(txt, larg, negrito) + 2);
      const pedacos = txt.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
      if (!pedacos.length) return;
      pedacos.forEach((p, i) => {
        const b = negrito || /^\*\*[^*]+\*\*$/.test(p);
        usar(b ? 'Helvetica-Bold' : 'Helvetica', fonte.tam);
        const t = p.replace(/^\*\*|\*\*$/g, '');
        const ultimo = i === pedacos.length - 1;
        if (i === 0) doc.text(t, x, doc.y, { width: larg, continued: !ultimo, lineGap: GAP, align });
        else doc.text(t, { continued: !ultimo, lineGap: GAP, align });
      });
      usar('Helvetica', fonte.tam);
      doc.x = M.esq;
    };

    const linhas = o.texto.replace(/\r/g, '').split('\n');
    let titulo = true;
    for (const bruta of linhas) {
      const l = bruta.trim();
      if (!l) { if (!titulo) doc.moveDown(0.35); continue; }
      if (titulo) {
        titulo = false;
        usar('Helvetica-Bold', 12);
        doc.text(l.replace(/\*\*/g, ''), M.esq, doc.y, { width: W, align: 'center' });
        usar('Helvetica', CORPO);
        doc.moveDown(1);
        continue;
      }
      if (l === '---') {
        // separador final: o texto de encerramento, a data e as assinaturas ficam juntos na mesma página
        const resto = linhas.slice(linhas.indexOf(bruta) + 1).filter((x) => x.trim());
        if (resto.length <= 3) espaco(resto.reduce((h, x) => h + altura(x, W) + 8, 0) + 190);
        regua(); continue;
      }
      if (/^CL[ÁA]USULA\b/i.test(l)) {
        regua();
        espaco(60);
        escrever(l, M.esq, W, true);
        doc.moveDown(0.45);
        continue;
      }
      const num = /^(\d{1,2})[.)]\s+(.+)$/.exec(l);
      if (num) {
        const corpo = num[2];
        if (/:$/.test(corpo) && corpo.length < 90 && !/\*\*/.test(corpo)) { // subtítulo do escopo ("1. Serviços Contábeis:")
          espaco(40);
          escrever(`${num[1]}. ${corpo}`, M.esq, W, true);
          doc.moveDown(0.45);
          continue;
        }
        espaco(altura(corpo, W - 36) + 2);
        const y = doc.y;
        usar('Helvetica', fonte.tam);
        doc.text(`${num[1]}.`, M.esq + 14, y, { width: 22, lineBreak: false });
        doc.y = y;
        escrever(corpo, M.esq + 36, W - 36);
        doc.moveDown(0.45);
        continue;
      }
      const marc = /^[-•]\s+(.+)$/.exec(l);
      if (marc) {
        espaco(altura(marc[1], W - 54) + 2);
        const y = doc.y;
        doc.circle(M.esq + 42, y + fonte.tam * 0.42, 1.9).fill('#000');
        doc.y = y;
        escrever(marc[1], M.esq + 54, W - 54);
        doc.moveDown(0.45);
        continue;
      }
      espaco(26);
      escrever(l, M.esq, W);
      doc.moveDown(0.45);
    }

    // Assinaturas: uma abaixo da outra, centralizadas (como no contrato em papel)
    const blocoAss = 92;
    espaco(blocoAss * 2 + (o.testemunhas ? 110 : 0) + 40);
    doc.moveDown(2.2);
    const largAss = 250, xAss = M.esq + (W - largAss) / 2;
    const assinatura = (p: Parte) => {
      const y = doc.y + 34;
      doc.save().moveTo(xAss, y).lineTo(xAss + largAss, y).lineWidth(0.7).strokeColor('#000').stroke().restore();
      usar('Helvetica-Bold', 10.5);
      doc.text(p.nome || FALTA, xAss - 40, y + 7, { width: largAss + 80, align: 'center' });
      doc.moveDown(0.3);
      doc.text(p.documento || FALTA, xAss - 40, doc.y, { width: largAss + 80, align: 'center' });
      usar('Helvetica', CORPO);
      doc.y += 12;
    };
    assinatura(o.contratante);
    assinatura(o.contratada);
    if (o.testemunhas) {
      espaco(110);
      const y = doc.y + 40, meia = (W - 40) / 2;
      [M.esq, M.esq + meia + 40].forEach((x, i) => {
        doc.save().moveTo(x, y).lineTo(x + meia, y).lineWidth(0.7).strokeColor('#000').stroke().restore();
        usar('Helvetica-Bold', 9.5);
        doc.text(`Testemunha ${i + 1}`, x, y + 6, { width: meia });
        usar('Helvetica', 9.5);
        doc.text('Nome:', x, doc.y + 2, { width: meia });
        doc.text('CPF:', x, doc.y + 2, { width: meia });
      });
      usar('Helvetica', CORPO);
    }
    doc.end();
  });
}
