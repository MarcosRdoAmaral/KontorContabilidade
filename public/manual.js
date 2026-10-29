/**
 * Manual do usuário do Kontor Gestão Contabilidade (mostrado em Relatórios > Documentação).
 * REGRA DO PROJETO: toda funcionalidade nova ou alterada precisa atualizar o tópico correspondente
 * aqui (e a data/versão em MANUAL_VERSAO) antes de publicar a versão.
 * `corpo` é HTML escrito à mão (não recebe dados de usuário).
 */
export const MANUAL_VERSAO = '1.11.0';

export const MANUAL = [
  {
    id: 'primeiros-passos', titulo: 'Primeiros passos', resumo: 'Instalação, primeiro acesso e o que configurar antes de emitir.',
    corpo: `
      <p>O Kontor Gestão Contabilidade é o sistema de gestão do escritório de contabilidade: carteira de clientes, agenda de obrigações e prazos, certificados e procurações, contratos e honorários e captura de documentos. Ele traz junto tudo o que o Kontor Gestão faz — emissão de NFS-e pelo <strong>Emissor Nacional</strong>, boletos, despesas, extrato e relatórios — para o escritório e para os clientes que emitem por ele.</p>
      <h3>Para começar a gestão do escritório</h3>
      <ol>
        <li><strong>Empresa do escritório:</strong> em Cadastros &gt; Empresas, cadastre o escritório e marque “Esta é a empresa do escritório”.</li>
        <li><strong>Carteira:</strong> cadastre os clientes (ou importe uma planilha com os CNPJs) (com o CNPJ, os dados vêm da Receita), com regime, responsável e perfil.</li>
        <li><strong>Equipe:</strong> em Configurações &gt; Usuários e acessos, crie um usuário para cada pessoa; eles aparecem como responsáveis.</li>
        <li><strong>Obrigações:</strong> confira o catálogo (Obrigações e prazos &gt; Catálogo) e a data “Controlar prazos a partir de”.</li>
        <li><strong>Honorários:</strong> cadastre o serviço de honorários na empresa do escritório, escolha-o em Contratos e honorários &gt; Configurar faturamento e crie os contratos.</li>
        <li><strong>Avisos:</strong> em Configurações &gt; Avisos de prazos, ligue o resumo diário por e-mail.</li>
      </ol>
      <h3>Antes da primeira nota</h3>
      <ol>
        <li><strong>Primeiro acesso:</strong> informe o nome do escritório e crie o usuário administrador.</li>
        <li><strong>Licença:</strong> em Configurações &gt; Licença, cole o código recebido para liberar a emissão.</li>
        <li><strong>Empresa:</strong> em Empresas, cadastre cada prestador (CNPJ, regime, município, ambiente).</li>
        <li><strong>Certificado A1:</strong> na linha da empresa, botão Certificado (arquivo .pfx e senha). Empresas que emitem só pelo portal com CNPJ e senha não precisam dele (veja <em>Empresas</em>).</li>
        <li><strong>Serviços e clientes:</strong> cadastre os serviços prestados e os clientes (tomadores).</li>
        <li><strong>Teste:</strong> mantenha a empresa em <em>Produção restrita (testes)</em> até validar tudo; só depois mude o ambiente para produção.</li>
      </ol>
      <h3>Como o sistema é organizado</h3>
      <p>No alto do menu lateral fica a <strong>empresa selecionada</strong>: quase todas as telas mostram os dados dela. Troque a empresa ali a qualquer momento. O restante do menu segue o fluxo do dia a dia: emitir, acompanhar notas, cobrar, controlar despesas e consultar relatórios.</p>
      <p class="dica">O menu mostra só o que o seu usuário tem permissão de usar (Configurações &gt; Usuários e acessos). Este manual está liberado para todos os usuários: em Relatórios &gt; Documentação, ou no item Documentação do menu para quem não tem o acesso a Relatórios.</p>`,
  },
  {
    id: 'visao', titulo: 'Visão geral do escritório', resumo: 'Prazos, certificados e honorários de toda a carteira numa tela.',
    corpo: `
      <p>Mostra, para o mês escolhido: clientes ativos por regime, obrigações entregues e em aberto, as atrasadas (inclusive de meses anteriores), certificados e procurações vencendo, o total de honorários e os boletos de honorário vencidos. Cada cartão leva à tela correspondente.</p>
      <p>A tabela <strong>Carga da equipe</strong> mostra quantas obrigações estão em aberto e atrasadas com cada responsável.</p>`,
  },
  {
    id: 'carteira', titulo: 'Carteira de clientes', resumo: 'Cadastro do cliente, regime, perfil, responsável e situação.',
    corpo: `
      <h3>Cadastrar</h3>
      <p>Em <em>Novo cliente</em>, digite o CNPJ e clique em Buscar: razão social, município, e-mail e a opção pelo Simples vêm da Receita Federal. Escolha o <strong>regime</strong> (MEI, Simples, Presumido, Real, imune/isenta ou pessoa física), o <strong>responsável</strong> e a data <strong>cliente desde</strong>.</p>
      <h3>Perfil</h3>
      <p>Três marcações definem as obrigações: <em>tem empregados</em> (folha, eSocial, FGTS, DCTFWeb, 13º), <em>contribuinte do ICMS</em> (EFD ICMS/IPI, DeSTDA) e <em>prestador de serviços</em> (ISS). Ao trocar o regime ou o perfil, as obrigações futuras ainda não iniciadas que deixaram de valer são retiradas; as de períodos passados ficam no histórico.</p>
      <h3>Situação</h3>
      <p><strong>Suspenso</strong> para de gerar obrigações. <strong>Encerrado</strong> pede a data: obrigações de períodos até ela continuam na agenda.</p>
      <h3>Endereço e representante legal</h3>
      <p>O endereço (o CEP preenche rua, bairro e cidade) e o representante legal (nome, CPF, RG, nacionalidade, estado civil e profissão) vão no contrato. Se faltarem, o contrato avisa e esses campos saem em branco no PDF, para preencher à mão.</p>
      <h3>Clientes e empresas são cadastros separados</h3>
      <p>A Carteira tem só os clientes da contabilidade. O próprio escritório (e qualquer empresa que use o sistema para emitir) fica em <strong>Cadastros → Empresas</strong>, onde se marca “Esta é a empresa do escritório”: ela emite as notas e os boletos de honorários e aparece como CONTRATADA nos contratos, com o endereço e o registro no CRC.</p>
      <h3>Importar planilha</h3>
      <p>Em <em>Importar planilha</em>, envie um Excel (.xlsx) ou .csv com o CNPJ (ou CPF e nome) em qualquer coluna. Para cada CNPJ o sistema consulta a Receita e cria o cliente com razão social, endereço, município, e-mail e o regime pela opção do Simples (MEI, Simples ou, se não optante, Lucro Presumido). Confira depois o regime, o perfil e o responsável de cada um.</p>
      <h3>Cadastro único</h3>
      <p>A Carteira é o único cadastro de clientes do escritório. A cobrança dos honorários de cada cliente fica em <strong>Faturamento</strong> (no botão ⋯ do cliente ou dentro de <em>Editar</em>): o que emitir (nota, boleto ou os dois), vencimento, e-mails de cobrança, serviços padrão com o valor, descontos, multa e juros e a descrição da nota. Nome, CNPJ/CPF, e-mail, telefone e endereço são sempre os da Carteira.</p>
      <p>Quem o escritório fatura mas não é cliente da contabilidade fica em <em>Clientes avulsos</em> (botão no topo da Carteira). Os avulsos que forem virar clientes aparecem em <em>Trazer avulsos</em>: escolha o regime de cada um e eles entram na Carteira, sem duplicar.</p>
      <p class="dica">Os tomadores das NFS-e que cada cliente emite (os clientes do seu cliente) ficam no botão ⋯ do cliente → <em>Tomadores das NFS-e deste cliente</em>.</p>
      <h3>Obrigações do cliente</h3>
      <p>O botão <em>Obrigações</em> mostra quais entram pela regra e permite exceções: incluir sempre (ex.: EFD-Reinf para quem tem retenções), dispensar, ou definir outro responsável só para aquela obrigação.</p>
      <p class="dica">O botão ⋯ leva aos dados de emissão (certificado A1, logo, dados bancários), à emissão de NFS-e e às NF-e recebidas do cliente.</p>`,
  },
  {
    id: 'obrigacoes', titulo: 'Obrigações e prazos', resumo: 'Agenda mensal, entregas, protocolo, dispensa e catálogo de obrigações.',
    corpo: `
      <h3>Prazos do mês</h3>
      <p>Lista as obrigações de todos os clientes com vencimento no mês, já ajustado a fins de semana e feriados (nacionais e os municipais cadastrados na empresa), e as atrasadas de meses anteriores. Filtre por responsável (“Minhas”), situação, esfera ou cliente.</p>
      <ul>
        <li><strong>Entregue:</strong> informe o protocolo/recibo; fica registrado quem entregou e quando.</li>
        <li><strong>Em andamento:</strong> para o que já começou.</li>
        <li><strong>Dispensada:</strong> exige o motivo (ex.: sem movimento).</li>
        <li>Marque várias e use <em>Marcar selecionadas como entregues</em>.</li>
      </ul>
      <h3>Catálogo</h3>
      <p>Vem com as obrigações mais comuns (DAS, DAS-MEI, DASN-SIMEI, DEFIS, eSocial, salários, FGTS Digital, EFD-Reinf, DCTFWeb, DARF previdenciário, PIS/COFINS, EFD-Contribuições, IRPJ/CSLL, ECD, ECF, EFD ICMS/IPI, DeSTDA, ISS, DMED e 13º salário). Cada uma tem a periodicidade, quantos meses após o período vence, a regra do dia (dia fixo, último dia útil ou N-ésimo dia útil) e o que fazer quando cai em dia não útil.</p>
      <p class="dica">Os prazos seguem a legislação conhecida, mas mudam: confira com a agenda tributária e ajuste no catálogo. Ao salvar, as tarefas em aberto são recalculadas. Prazos municipais e estaduais (ISS, ICMS) variam por local.</p>
      <h3>Controlar a partir de</h3>
      <p>Vencimentos anteriores a esta data não entram na agenda, para não aparecerem como atrasadas obrigações entregues antes de usar o sistema.</p>`,
  },
  {
    id: 'certificados', titulo: 'Certificados e procurações', resumo: 'Validade dos A1, A3, e-CPF e procurações eletrônicas.',
    corpo: `
      <p><strong>Enviar o A1 do cliente:</strong> em <em>Cadastrar</em>, escolha o tipo <em>Certificado A1</em> e o cliente, selecione o arquivo .pfx/.p12 e digite a senha. Titular, CNPJ e validade são lidos do arquivo; o certificado fica guardado criptografado na empresa do cliente e passa a ser usado para emitir NFS-e, buscar NF-e e capturar documentos. Para trocar um A1 que venceu, use <em>Trocar A1</em> na linha dele.</p>
      <p>Os certificados A1 enviados em Empresas &gt; Certificado também aparecem sozinhos. Cadastre aqui os A3 (token/cartão), e-CPF dos sócios e as procurações eletrônicas (e-CAC, SEFAZ, prefeitura), com a validade e onde ficam guardados.</p>
      <p>A situação mostra os vencidos e os que vencem em 7 e 30 dias. Ao renovar, use <em>Renovado</em> e informe a nova validade: o registro antigo fica no histórico e sai dos avisos.</p>`,
  },
  {
    id: 'honorarios', titulo: 'Contratos e honorários', resumo: 'Contrato em PDF, assinatura, faturamento automático, reajuste e 13º.',
    corpo: `
      <h3>Configurar uma vez</h3>
      <ol>
        <li>Marque em Cadastros &gt; Empresas qual é a empresa do escritório.</li>
        <li>Com ela selecionada no topo, cadastre o serviço de honorários em Cadastros &gt; Serviços (e, para boletos, os Dados bancários).</li>
        <li>Em Contratos e honorários &gt; Configurar faturamento, escolha esse serviço.</li>
      </ol>
      <h3>Contrato</h3>
      <p>Informe o cliente, início, valor, dia da emissão e do vencimento, como cobrar (só nota, nota + boleto ou só boleto), índice e mês do reajuste, 13º honorário e o escopo. O texto sai do modelo (aba Modelos de contrato) em PDF, pronto para enviar. Registre <em>Enviado</em> e <em>Assinado</em> e anexe a via assinada.</p>
      <h3>Modelo e marca d’água</h3>
      <p>O modelo padrão traz nove cláusulas (objeto, obrigações das partes, honorários, prazo e rescisão, confidencialidade, responsabilidade, LGPD e foro), com a qualificação completa das partes, numeração de página e linhas para as assinaturas e, se marcado no modelo, para duas testemunhas. Em <em>Modelos de contrato</em> você edita o texto (veja “Como escrever o modelo”) e confere o resultado em <em>Ver exemplo</em>.</p>
      <p>Na mesma aba fica a <strong>marca d’água</strong>: envie a imagem (PNG ou JPG) ou use a logo da empresa do escritório e escolha a intensidade. Se a imagem já vier clarinha, escolha “Usar a imagem como está”. Ela sai no centro de todas as páginas, atrás do texto.</p>
      <h3>Faturamento automático</h3>
      <p>Ao assinar, o cliente vira cliente da empresa do escritório (com o endereço da Receita), com o honorário como serviço padrão e a emissão automática ligada. Todo mês, em Faturamento &gt; Emissão automática (empresa do escritório selecionada), os honorários ficam prontos para conferir e confirmar. Encerrar o contrato desliga a emissão.</p>
      <h3>Reajuste</h3>
      <p>Na aba Reajustes aparecem os contratos que fazem aniversário no mês. O botão busca o IPCA, IGP-M ou INPC acumulado em 12 meses no Banco Central; o percentual pode ser editado. O novo valor já vale para a próxima emissão e fica no histórico.</p>
      <h3>13º honorário e atrasos</h3>
      <p>Contratos com 13º aparecem na aba 13º honorário para emitir em dezembro. A aba Em atraso mostra os boletos de honorário vencidos por cliente.</p>`,
  },
  {
    id: 'captura', titulo: 'Captura de documentos', resumo: 'NF-e de compra e de venda, NFS-e prestadas e tomadas de todos os clientes, e o pacote do mês.',
    corpo: `
      <p>Uma tela para os documentos de toda a carteira, mês a mês. A tabela mostra, por cliente, as NF-e de compra, as NF-e de venda, as NFS-e prestadas e as tomadas.</p>
      <h3>NF-e de compra</h3>
      <p>Com o certificado A1 do cliente (Cadastros &gt; Empresas &gt; Certificado), o sistema consulta a SEFAZ e baixa as NF-e emitidas contra ele.</p>
      <h3>NF-e de venda</h3>
      <p>A SEFAZ não devolve ao emitente as notas que ele mesmo emitiu. Por isso, peça a cada cliente para informar o <strong>CNPJ do escritório</strong> no campo <em>“Autorizados a baixar o XML” (autXML)</em> do sistema emissor de notas dele (o CNPJ aparece na tela, com o botão Copiar). Daí em diante, as notas de venda chegam pelo certificado A1 do <strong>escritório</strong> e vão para o cliente certo pelo CNPJ do emitente. Para isso, envie o certificado A1 da empresa do escritório em Cadastros &gt; Empresas.</p>
      <p class="dica">Só chegam as notas emitidas depois que o cliente configurar o campo. NFC-e (cupom) não entra nessa distribuição. Notas de CNPJs que ainda não estão na carteira ficam guardadas e aparecem no cliente assim que ele for cadastrado.</p>
      <h3>NFS-e prestadas e tomadas</h3>
      <p>Com o certificado A1 do cliente, o sistema consulta o Ambiente de Dados Nacional da NFS-e e baixa as notas de serviço em que ele é prestador ou tomador, inclusive as emitidas em outros sistemas, com os cancelamentos. Vale para os municípios que usam o padrão nacional; os que têm sistema próprio de prefeitura não enviam as notas para lá.</p>
      <h3>Buscar e acompanhar</h3>
      <p><em>Buscar agora</em> consulta todos os clientes que já podem: SEFAZ e Ambiente Nacional pedem 1 hora entre consultas quando não há notas novas. <em>Ligar busca automática</em> faz isso sozinho enquanto o programa estiver aberto. O botão <em>Notas</em> mostra as notas de venda e de serviço do mês, com o XML de cada uma; <em>Compras</em> abre as NF-e de compra do cliente.</p>
      <p><em>Pacote do mês</em> gera um ZIP com os XML de compras, vendas e serviços (prestados e tomados) e planilhas de conferência.</p>`,
  },
  {
    id: 'integra-contador', titulo: 'Conferir na Receita (Integra Contador)', resumo: 'PGDAS-D, DCTFWeb e DEFIS conferidos direto na Receita Federal.',
    corpo: `
      <p>O <strong>Integra Contador</strong> é o serviço do SERPRO que dá aos escritórios acesso, em nome dos clientes, ao que foi transmitido à Receita Federal. Com ele, o botão <strong>Conferir na Receita</strong>, em Obrigações e prazos, consulta o <strong>PGDAS-D</strong> (com a informação de DAS pago), a <strong>DCTFWeb</strong> e a <strong>DEFIS</strong> e marca como entregue o que já foi transmitido, com o número da declaração e a data.</p>
      <h3>Configurar (administrador)</h3>
      <ol>
        <li>Contrate o Integra Contador na Loja Serpro com o e-CNPJ do escritório. O Consumer Key e o Consumer Secret ficam na Área do Cliente Serpro.</li>
        <li>Envie o certificado A1 da empresa do escritório em Cadastros &gt; Empresas: a autenticação é feita com ele.</li>
        <li>Em Configurações &gt; Integra Contador, informe as chaves, escolha Produção e use <em>Testar conexão</em>. O ambiente de Demonstração responde com dados fictícios, para testar antes do contrato.</li>
        <li>Cada cliente outorga procuração eletrônica ao CNPJ do escritório no e-CAC, com os serviços do Simples Nacional e da DCTFWeb.</li>
      </ol>
      <p class="dica">Se o SERPRO responder “Versão Descontinuada”, ele mudou a versão de algum serviço. Em Configurações &gt; Integra Contador &gt; Avançado, informe a versão nova no formato SISTEMA=versão (ex.: SITFIS=2.0) ou aguarde a atualização do sistema.</p>
      <h3>Conferir</h3>
      <p>Em Obrigações e prazos, escolha o mês e clique em <em>Conferir na Receita</em>. O sistema mostra quantas consultas vai fazer (o SERPRO cobra por consulta) e, ao confirmar, confere as DAS, DCTFWeb e DEFIS em aberto, inclusive as atrasadas. Para conferir só alguns clientes, marque as linhas antes: o botão passa a <em>Conferir N selecionada(s) na Receita</em> e consulta só essas. O PGDAS-D de um ano inteiro sai numa consulta só por cliente. O que não for localizado continua em aberto; clientes sem procuração aparecem na lista de erros.</p>
      <p class="dica">EFD, ECD, ECF, eSocial, FGTS e as obrigações estaduais e municipais não passam pelo Integra Contador e continuam sendo marcadas à mão.</p>`,
  },
  {
    id: 'situacao-fiscal', titulo: 'Situação fiscal', resumo: 'O que está em aberto na Receita Federal e na PGFN, cliente a cliente.',
    corpo: `
      <p>Consulta, pelo Integra Contador, o <strong>Relatório de Situação Fiscal</strong> da Receita Federal e da Procuradoria-Geral da Fazenda Nacional (o mesmo do e-CAC) e mostra o que está em aberto: débitos, omissões de declaração e inscrições em dívida ativa, com o saldo de cada um. O PDF original fica guardado.</p>
      <h3>Consultar</h3>
      <p>Em Escritório &gt; Situação fiscal, marque os clientes e clique em <em>Consultar selecionados</em>. A Receita leva alguns segundos para gerar cada relatório; se ainda não estiver pronto, o cliente fica como <em>Aguardando a Receita</em> e o botão <em>Atualizar</em> busca o relatório depois, sem pedir outro. Cada consulta usa duas chamadas ao Integra Contador.</p>
      <h3>Resultado</h3>
      <ul>
        <li><strong>Com pendências:</strong> o botão <em>Detalhes</em> mostra o total dos débitos na Receita Federal (saldo com multa e juros), os <strong>impostos em aberto agrupados por tributo</strong>, a lista completa dos débitos (com período, vencimento e número da notificação, no caso das multas por atraso) e as inscrições em dívida ativa na PGFN, com a situação (ajuizada ou a ser cobrada). O relatório não traz o valor das inscrições: consulte no Regularize. Débitos e parcelamentos com exigibilidade suspensa aparecem à parte, porque não impedem a certidão. A última certidão aparece com a validade, em vermelho se estiver vencida.</li>
        <li><strong>Regular:</strong> o relatório não trouxe pendências.</li>
        <li><strong>Conferir o PDF:</strong> o relatório veio num formato que o sistema não conseguiu ler; abra o PDF.</li>
      </ul>
      <p>Clientes com pendência aparecem primeiro na lista e na Visão geral. Os valores são lidos do relatório: em caso de dúvida, vale o PDF.</p>
      <h3>Recalcular guias</h3>
      <p>Em <em>Detalhes</em>, cada débito da Receita tem o botão <strong>Recalcular</strong>: confira os dados, informe a data de pagamento e clique em <em>Gerar guia (PDF)</em>. Sai um PDF por guia, que também fica guardado em <em>Guias recalculadas</em>. O sistema escolhe o tipo de guia, e dá para trocar:</p>
      <ul>
        <li><strong>DARF (Sicalc):</strong> débitos da Receita e multas por atraso de declaração (MAED, com o número da notificação). Multa e juros até a data de pagamento.</li>
        <li><strong>DAS de cobrança:</strong> Simples Nacional, com o valor em cobrança na Receita (já descontando pagamentos parciais e parcelas) e a validade definida pela Receita.</li>
        <li><strong>Guia da DCTFWeb:</strong> contribuições previdenciárias (CP-patronal, terceiros), com todos os débitos do período de apuração.</li>
      </ul>
      <p><em>Outra guia</em> recalcula informando os dados à mão. Nada é gerado sozinho: cada guia é uma chamada ao Integra Contador, cobrada pelo SERPRO. As inscrições em dívida ativa (PGFN) não saem pelo Integra Contador: use o Regularize.</p>
      <h3>Aviso de débitos ao cliente</h3>
      <p>Marque na coluna <strong>Avisar</strong> os clientes que devem receber por e-mail o aviso de débitos em aberto (quem já sabe e não paga normalmente pode ficar desmarcado). O aviso lista os débitos por tributo e as inscrições em dívida ativa, sem guias: o cliente procura o escritório quando quiser pagar. Ele sai depois da consulta automática, se a opção <em>avisar os clientes marcados</em> estiver ligada (uma vez por consulta), ou na hora, pelo botão <em>Avisar o cliente agora</em> em Detalhes, que mostra o texto antes de enviar.</p>
      <h3>FGTS Digital</h3>
      <p>O botão <strong>Consultar FGTS Digital</strong> (no aplicativo instalado) abre o portal do FGTS Digital numa janela do Kontor. Clique em <em>Entrar com GOV.BR</em> e escolha o <strong>certificado do escritório</strong> (o Kontor pergunta qual usar). Depois do login, o Kontor troca o perfil para <em>Procurador</em> de cada cliente selecionado (sem seleção, os que têm funcionários) e lê as competências em aberto da Emissão de Guia Rápida, com vencimento, trabalhadores e valores. Nada é emitido nem alterado no portal.</p>
      <p>O resultado aparece na coluna <em>FGTS Digital</em> (em dia, valor em aberto, sem procuração) e o detalhe fica guardado com a data. A guia é emitida no próprio portal. O cliente precisa ter dado procuração ao escritório no FGTS Digital, e o certificado A1 do escritório precisa estar instalado no Windows (dois cliques no arquivo .pfx). A sessão do portal dura cerca de 30 minutos.</p>
      <h3>Consulta automática</h3>
      <p>No quadro <em>Consulta automática</em> (administrador), escolha um ou dois dias do mês e os e-mails que recebem o resultado. Nesses dias, a partir das 7h e com o programa aberto, o sistema consulta todos os clientes ativos e manda um e-mail com quem tem pendência, separando as <strong>pendências novas</strong> das que continuam e listando os clientes que não puderam ser consultados (sem procuração, por exemplo). Se o computador estiver desligado no dia, a consulta roda na próxima abertura do programa. Relatórios que a Receita ainda estava gerando são buscados sozinhos nas rodadas seguintes.</p>
      <p class="dica">O quadro mostra quantas chamadas ao Integra Contador a consulta automática faz por mês (duas por cliente em cada rodada).</p>
      <p class="dica">É preciso o Integra Contador configurado (Configurações &gt; Integra Contador) e a procuração eletrônica do cliente para o escritório no e-CAC.</p>`,
  },
  {
    id: 'avisos', titulo: 'Avisos de prazos por e-mail', resumo: 'Resumo diário de atrasos, vencimentos, certificados e reajustes.',
    corpo: `
      <p>Em Configurações &gt; Avisos de prazos (administrador), ligue o resumo e informe até 5 e-mails. Nos dias úteis, a partir das 7h e com o programa aberto, sai um e-mail com as obrigações atrasadas e as que vencem nos próximos dias, certificados vencidos ou vencendo e os reajustes do mês. Usa o e-mail configurado em Configurações &gt; E-mail.</p>`,
  },
  {
    id: 'empresas', titulo: 'Empresas', resumo: 'Cadastro do prestador, certificado, logo, dados bancários e emissão sem certificado.',
    corpo: `
      <h3>Cadastrar</h3>
      <p>Em <strong>Empresas &gt; Cadastrar empresa</strong> informe o CNPJ (o botão de busca preenche razão social e endereço), o regime (não optante, MEI ou Simples ME/EPP), o município e o ambiente. Use <em>Produção restrita</em> para testes: as notas não têm valor fiscal.</p>
      <h3>Certificado A1</h3>
      <p>A API da Sefin exige certificado digital A1 da empresa. Na linha da empresa, <strong>Certificado</strong> envia o arquivo .pfx e a senha; o sistema guarda criptografado e mostra a validade. Renove antes de vencer.</p>
      <h3>Emissão sem certificado (CNPJ e senha)</h3>
      <p>Para empresas que emitem direto no portal do Emissor Nacional, escolha o modo <strong>Portal (CNPJ e senha)</strong> no cadastro. Nesse modo o sistema <em>não emite a nota</em>: você emite no portal e importa o XML em <strong>Notas emitidas &gt; Importar XML</strong>. Os boletos, as cobranças e os relatórios continuam funcionando normalmente. A senha do portal fica guardada criptografada.</p>
      <h3>Logo</h3>
      <p>O botão <strong>Logo</strong> envia a imagem que aparece no DANFSe (PDF da nota) dessa empresa.</p>
      <h3>Dados bancários</h3>
      <p>O botão <strong>Dados bancários</strong> da linha da empresa abre a configuração da cobrança (convênio Ailos): agência, conta, convênio, carteira, formato CNAB, numeração do próximo boleto e da próxima remessa, multa, juros, instrução e <em>feriados municipais</em>. Sem isso não é possível gerar boletos. Se já emitia boletos em outro sistema, informe o próximo número livre para o nosso número nunca repetir.</p>`,
  },
  {
    id: 'clientes', titulo: 'Clientes', resumo: 'Tomadores, forma de faturar, vencimento e serviços padrão.',
    corpo: `
      <p>Em <strong>Clientes</strong> ficam os tomadores de cada empresa. Informe o CNPJ/CPF (a busca preenche os dados), endereço e e-mail.</p>
      <p class="dica">Esta tela não fica mais no menu: abra pela Carteira (⋯ do cliente → <em>Tomadores das NFS-e deste cliente</em>, ou <em>Clientes avulsos</em> para os do escritório). Os clientes da contabilidade são faturados pela Carteira, botão <em>Faturamento</em>.</p>
      <h3>Importar clientes de uma planilha</h3>
      <p>Em <strong>Clientes → Importar planilha</strong>, envie um arquivo Excel (.xlsx) ou .csv com o <strong>CNPJ</strong> (ou CPF) e, se quiser, o nome, em qualquer coluna. O sistema mostra quantos são novos, quais já estão cadastrados, repetidos ou inválidos. Ao importar, ele <strong>consulta cada CNPJ na Receita Federal</strong> e preenche razão social, endereço, e-mail e telefone. CPF precisa do nome na planilha. CNPJ que o Excel mostrou sem o zero à esquerda é reconhecido.</p>
      <p>Todo cliente criado assim fica com a marca <strong>Falta conferir</strong>, com o motivo (endereço incompleto, sem e-mail, situação na Receita, Receita fora do ar). Use a aba <em>Falta conferir</em> da lista, complete o cadastro e marque <em>Cadastro conferido</em> para tirar a marca.</p>
      <h3>Como faturar</h3>
      <ul>
        <li><strong>Somente nota:</strong> emite a NFS-e.</li>
        <li><strong>Nota + boleto:</strong> emite a nota e gera o boleto.</li>
        <li><strong>Somente boleto:</strong> gera só a cobrança.</li>
      </ul>
      <h3>Vencimento</h3>
      <p>Por prazo (X dias após a emissão) ou em dia fixo do mês. Boleto não vence em sábado, domingo ou feriado: o sistema antecipa para o dia útil anterior.</p>
      <h3>Serviços padrão e agenda</h3>
      <p>Na aba <strong>Serviços padrão</strong> do cliente, cadastre o serviço e o valor que se repetem todo mês; eles alimentam a <em>Emissão automática</em>. Também é ali que se define o envio automático por e-mail.</p>`,
  },
  {
    id: 'servicos', titulo: 'Serviços e tributação', resumo: 'Cadastro do serviço, código nacional, NBS, retenções.',
    corpo: `
      <p>Em <strong>Serviços</strong> cadastre cada serviço prestado pela empresa selecionada: descrição que sai na nota, código de tributação nacional (cTribNac), alíquota e, se for o caso, NBS.</p>
      <h3>Tributação do serviço</h3>
      <p>O serviço <strong>não guarda</strong> alíquotas nem retenções: ele apenas aponta para uma <strong>tributação</strong> (campo <em>Tributação</em> do cadastro). Alíquota do ISS, ISSQN, imunidade, retenções (PIS, COFINS, CSLL, IRRF, INSS), totais aproximados, município e IBS/CBS ficam na tributação, em <strong>Tributação</strong>. Sem escolha, vale a tributação padrão de saída da empresa. Serviços antigos foram convertidos automaticamente.</p>
      <p class="dica">Confira sempre o enquadramento com o contador. O sistema só repete o que foi cadastrado.</p>`,
  },
  {
    id: 'emitir', titulo: 'Emitir nota', resumo: 'Passo a passo da emissão, F2 para clientes e boleto junto.',
    corpo: `
      <ol>
        <li>Abra <strong>Emitir nota</strong> (confira a empresa no alto do menu).</li>
        <li><strong>Cliente:</strong> comece a <strong>digitar o nome</strong> (ou o CNPJ/CPF): a lista se filtra enquanto você escreve; use as setas e Enter, ou clique no cliente. Apagar o campo volta para <em>Consumidor não identificado</em>. <kbd>F2</kbd> abre a consulta completa, em janela. Também dá para cadastrar um cliente novo ali mesmo.</li>
        <li><strong>Serviço:</strong> ao escolher, descrição e código são preenchidos e a <strong>tributação</strong> do serviço é selecionada.</li>
        <li><strong>Cliente com descrição composta:</strong> se o cliente tem esse modelo (aba <em>Descrição da nota</em> no cadastro), aparece um bloco com período, ordem de compra e o valor de cada linha (ex.: mão de obra e aluguel de máquinas). A descrição, o valor total e o INSS retido (só sobre as linhas marcadas) são calculados sozinhos; PIS, COFINS, CSLL e IR seguem o tributação, sobre o total.</li>
        <li><strong>Tributação:</strong> traz alíquota, ISSQN, retenções, totais aproximados, município e informações complementares (na data da competência). Trocar a tributação refaz o preenchimento; os campos ainda podem ser ajustados na nota.</li>
        <li><strong>Conferência da tributação:</strong> no fim do formulário, uma tabela mostra cada imposto com base, alíquota e valor (ISS, retenções federais, IBS/CBS informativo), o total retido e o <strong>líquido a receber</strong>, atualizada conforme você digita.</li>
        <li>Informe competência, valor e, se precisar, ajuste descrição e retenções.</li>
        <li>Se o cliente fatura com boleto, no bloco <strong>Pagamento / parcelamento</strong> (logo depois de Serviço e retenções, onde já está o líquido da NFS-e) defina o vencimento (já sugerido pela regra do cliente). Para <strong>parcelar</strong>, informe o número de parcelas (use <em>Dias entre parcelas</em> para intervalos fixos, como 15 ou 30 dias, ou a <em>Condição de pagamento</em>, como 30/60/90, que define sozinha as parcelas e os vencimentos a partir de hoje): o sistema divide o valor e sugere um vencimento por mês; ajuste data e valor de cada parcela (a soma precisa fechar com o boleto). Cada parcela vira um boleto, com o seu vencimento, e todos seguem no e-mail.</li>
        <li><strong>Emitir.</strong> O sistema monta a DPS, assina com o certificado e envia à Sefin.</li>
      </ol>
      <p><strong>Retenção dispensada:</strong> retenção de até R$ 10,00 não é feita, a cada pagamento: PIS + COFINS + CSLL são somados (Lei 10.833/2003, art. 31, § 3º) e o IRRF é avaliado à parte (Lei 9.430/1996, art. 67). O valor dispensado <em>não se acumula</em> com notas seguintes (Solução de Consulta RFB 258/2024). O sistema aplica isso ao calcular as retenções pelos percentuais e na emissão automática, e mostra “Dispensada” na conferência. Para reter mesmo assim, digite o valor retido.</p>
      <h3>Se algo der errado</h3>
      <ul>
        <li><strong>Rejeitada:</strong> a tela da nota mostra o código e o motivo. Use <em>Corrigir e reenviar</em>; o número da DPS é mantido.</li>
        <li><strong>Sem resposta da Sefin:</strong> use <em>Consultar na Sefin</em> antes de reenviar; a nota pode já ter sido gerada e é recuperada sem duplicar.</li>
      </ul>
      <p class="dica">Em produção restrita as notas são de teste e não têm valor fiscal.</p>`,
  },
  {
    id: 'notas', titulo: 'Notas emitidas', resumo: 'Consultar, baixar, enviar, cancelar, excluir e importar XML.',
    corpo: `
      <p>A lista mostra as notas da empresa com situação, número, cliente e valor. Clique na nota para ver o detalhe.</p>
      <h3>O que dá para fazer</h3>
      <ul>
        <li><strong>Abrir DANFSe</strong> (PDF) e <strong>baixar o XML</strong>.</li>
        <li><strong>Consultar no portal nacional</strong>.</li>
        <li><strong>Enviar por e-mail</strong> ou WhatsApp ao cliente (só notas de produção).</li>
        <li><strong>Cancelar nota:</strong> só para nota autorizada, com motivo de pelo menos 15 caracteres. A nota fica <em>Cancelada</em> e continua no histórico.</li>
        <li><strong>Excluir nota:</strong> só para nota <em>não autorizada</em> (rejeitada, pendente ou sem resposta). Nota autorizada ou cancelada <u>nunca</u> pode ser excluída. Os boletos ligados continuam no sistema. Só aparece para o administrador e para usuários com a permissão <em>Excluir registros</em>.</li>
        <li><strong>Importar XML:</strong> traz para o sistema notas emitidas fora (por exemplo, no portal, para empresas sem certificado).</li>
        <li><strong>Baixar em lote</strong> as notas de um período (PDF e XML).</li>
      </ul>
      <p class="dica">Dúvida se a Sefin gerou a nota? Use <em>Consultar na Sefin</em> antes de excluir uma nota pendente.</p>`,
  },
  {
    id: 'agenda', titulo: 'Emissão automática', resumo: 'Preparar as notas e boletos do mês e confirmar de uma vez.',
    corpo: `
      <p>Para clientes com cobrança todo mês. O sistema <strong>prepara</strong> a emissão na data de cada cliente, usando o serviço padrão e o valor cadastrados; <strong>nada é emitido sem a sua confirmação</strong>.</p>
      <h3>Configurar</h3>
      <ol>
        <li>Em <strong>Clientes</strong>, cadastre o serviço e o valor na aba Serviços padrão.</li>
        <li>Em <strong>Emissão automática</strong>, clique em <em>Agendar</em> no cliente e escolha o dia do mês.</li>
      </ol>
      <h3>No dia a dia</h3>
      <p>Escolha o mês. Cada item aparece como <em>Pronta</em>, <em>Agendada</em> (ainda não chegou a data), <em>Emitida</em>, <em>Com erro</em> ou <em>Pulada</em>. Use <em>Emitir</em> em um item, <strong>Emitir prontas</strong> para todos de uma vez, <em>Pular</em> para ignorar o mês ou <em>Tentar de novo</em> nos que deram erro. Conforme o cliente, gera nota, nota + boleto ou só boleto.</p>`,
  },
  {
    id: 'cobrancas', titulo: 'Cobranças e boletos', resumo: 'Boletos Ailos, remessa, retorno e baixas.',
    corpo: `
      <p>A tela <strong>Cobranças</strong> lista os boletos da empresa com situação (pendente, pronto, enviado ao banco, registrado, pago, cancelado).</p>
      <h3>Multa, juros e desconto por cliente</h3>
      <p>No cadastro do cliente, aba <strong>Descontos</strong>, você pode definir <em>multa</em> e <em>juros ao mês</em> próprios (em branco vale o padrão dos dados bancários da empresa; 0 isenta o cliente) e um <em>desconto por pagamento antecipado</em>: um percentual do boleto, válido até certo número de dias antes do vencimento (0 = até o vencimento). O desconto vai na remessa ao banco como desconto até a data e sai nas instruções impressas; depois do prazo vale o valor cheio. O boleto guarda as condições vigentes na data em que foi criado, então mudar o cadastro depois não altera boletos já emitidos.</p>
      <h3>Fluxo com o banco (Ailos)</h3>
      <ol>
        <li>Configure os <em>Dados bancários</em> da empresa (em Empresas).</li>
        <li>Os boletos são gerados na emissão, no faturamento automático ou como <strong>boleto avulso</strong>.</li>
        <li>Gere a <strong>remessa</strong> (arquivo CNAB) e envie no Ailos Conta Online: Cobrança Bancária &gt; Arquivo de Cobrança.</li>
        <li>Depois do pagamento, baixe o <strong>arquivo de retorno</strong> no mesmo menu e importe aqui para dar baixa automática.</li>
      </ol>
      <h3>Outras ações</h3>
      <ul>
        <li><strong>Boleto:</strong> abre o PDF para imprimir ou enviar. <strong>WhatsApp</strong> abre a mensagem pronta.</li>
        <li><strong>Marcar pago:</strong> baixa manual. <strong>Reemitir:</strong> altera vencimento ou valor. <strong>Cancelar:</strong> se já foi ao banco, a baixa vai na próxima remessa.</li>
      </ul>`,
  },
  {
    id: 'compras', titulo: 'Compras (NF-e de entrada)', resumo: 'Buscar na SEFAZ as NF-e emitidas contra o CNPJ, importar o XML e lançar nas despesas.',
    corpo: `
      <p>O grupo <strong>Compras</strong> tem duas telas: <strong>Compras</strong> (lançar e consultar notas, num lugar só) e <strong>Buscar NF-e (SEFAZ)</strong> (notas emitidas contra o CNPJ). Na tela Compras, busque por fornecedor, número da nota, CNPJ ou chave, no período, e use <em>Importar XML da NF-e</em> ou <em>Lançar compra manual</em>.</p>
      <p>Toda nota que entra, pelo XML ou pela SEFAZ, abre <em>nota a nota</em> com o resumo (fornecedor, totais, itens) e o <strong>parcelamento da nota</strong>. Se o pagamento real for diferente, altere datas e valores, adicione ou remova parcelas, ou use <em>Refazer</em> em N parcelas a cada X dias; a soma precisa fechar com o total. Em <em>Condição de pagamento</em> escolha <strong>À vista</strong> (o parcelamento some e a <em>forma de pagamento</em> passa a ser obrigatória: PIX, débito, crédito ou dinheiro, que vai para as despesas geradas) ou <strong>Parcelado</strong> (abre o parcelamento).</p>
      <h3>Buscar NF-e (SEFAZ)</h3>
      <p>Com o certificado A1 da empresa cadastrado, a tela <strong>Buscar NF-e (SEFAZ)</strong> traz as NF-e emitidas contra o CNPJ direto do Ambiente Nacional, sem precisar pedir o XML ao fornecedor.</p>
      <ol>
        <li>Clique em <strong>Buscar agora</strong>. O sistema baixa as notas novas e registra a <em>Ciência da Operação</em> em cada uma: é ela que libera o XML completo na SEFAZ.</li>
        <li>O XML completo chega numa <strong>próxima busca</strong>. Deixe <em>Buscar automaticamente</em> marcado e o sistema consulta sozinho enquanto estiver aberto.</li>
        <li>Quando a nota aparecer como <strong>Pronta para importar</strong>, use <strong>Importar</strong> (ou marque várias e <em>Importar selecionadas</em>). Ela entra em Compras como se o XML tivesse sido enviado, com a opção de lançar as parcelas nas despesas.</li>
      </ol>
      <p><strong>Intervalo da SEFAZ:</strong> quando não há documentos novos, a SEFAZ só aceita nova consulta depois de 1 hora; o sistema respeita isso e mostra o horário liberado. Para uma nota específica, use <strong>Buscar pela chave</strong>.</p>
      <p>Notas <strong>canceladas pelo fornecedor</strong> aparecem riscadas e não podem ser importadas; se o cancelamento chegar depois da importação, um alerta em vermelho pede para conferir a compra. <strong>Ocultar</strong> esconde notas que não são compras da empresa (por exemplo, quando ela aparece só como transportadora). A Ciência da Operação não é a manifestação final: Confirmação, Desconhecimento ou Operação não Realizada continuam com o seu processo fiscal.</p>
      <p><strong>Conexão com a SEFAZ</strong> (administrador): o servidor da SEFAZ usa certificado ICP-Brasil, que o Windows nem sempre reconhece. O sistema já traz essa cadeia embutida (raízes v5, v10, v11 e v12 e as ACs SSL dos servidores da SEFAZ), então normalmente não há nada a fazer. Se um dia a busca avisar que não reconhece o certificado do servidor, use <em>Atualizar pelo site do ITI</em> ou envie o pacote <em>ACcompactado.zip</em> baixado pelo navegador.</p>
      <h3>Importar o XML da NF-e</h3>
      <ol>
        <li>Clique em <strong>Importar XML da NF-e</strong> e escolha um ou <em>vários</em> arquivos de uma vez (o XML que o fornecedor envia ou que se baixa no portal da NF-e).</li>
        <li>Deixe marcado <em>Lançar nas despesas</em> se quiser que cada parcela (duplicata) vire uma despesa na data de vencimento, na categoria escolhida; nota à vista vira uma despesa só.</li>
        <li>O resultado aparece arquivo por arquivo. O sistema lê fornecedor, itens (com NCM e CFOP), totais e parcelas.</li>
      </ol>
      <p>O sistema avisa e <strong>não importa</strong> quando a nota já foi importada, quando foi emitida pela própria empresa (é uma venda), ou quando o XML é de NFS-e ou de evento. Se o destinatário da nota for outro CNPJ, importa com um alerta para você conferir a empresa selecionada.</p>
      <h3>Compra manual</h3>
      <p><strong>Lançar compra manual</strong> registra uma compra sem XML (cupom, recibo). No fornecedor, digite para buscar ou use <strong>F2</strong> para consultar os fornecedores que já tiveram nota lançada; se for novo, informe o CNPJ e clique em <em>Buscar CNPJ</em> (ou saia do campo) para preencher o nome pela Receita. Informe o valor e a condição de pagamento: à vista (com a forma de pagamento) ou parcelado.</p>
      <h3>Detalhe, XML e exclusão</h3>
      <p>Clique na compra para ver itens, totais e parcelas e baixar o XML. <strong>Alterar parcelas</strong> refaz o parcelamento e acerta as despesas geradas (se uma parcela já estiver ligada ao extrato, desfaça o vínculo antes). Cada parcela vira uma despesa; quando o pagamento aparecer no extrato, ligue-o em <em>Extrato e conciliação</em>. <strong>Excluir compra</strong> (permissão <em>Excluir registros</em>) apaga também as despesas que ela gerou. O relatório <em>Compras (NF-e de entrada)</em> está em Relatórios. O acesso a Compras é liberado por usuário em Configurações &gt; Usuários e acessos.</p>`,
  },
  {
    id: 'tributacao', titulo: 'Tributação e apuração assistida', resumo: 'Impostos, tributações e comparação com o que as notas declaram.',
    corpo: `
      <p>Em <strong>Tributação</strong> você cadastra os impostos uma vez, monta cada <em>tributação</em> e só então vincula serviços e compras a ela.</p>
      <h3>1. Impostos</h3>
      <p>Catálogo pronto: ISS, ICMS, IPI, PIS, COFINS, CSLL, IRRF, INSS, IBS (estadual e municipal) e CBS. Dá para renomear e desativar o que a empresa não usa.</p>
      <h3>2. Tributações</h3>
      <p>Uma tributação é um conjunto de linhas: imposto, alíquota, redução de base, se é <strong>retido</strong>, CST e cClassTrib (IBS/CBS) e a <strong>vigência</strong> (de/até). Como as alíquotas do IBS/CBS mudam ao longo da transição, use uma linha por período; vale a que está em vigor na data do documento.</p>
      <h3>3. Onde a tributação se aplica</h3>
      <p>Na própria tributação você diz se ela vale para <em>serviços prestados</em> (saída) ou <em>compras</em> (entrada), a natureza (serviço, revenda, insumo, uso e consumo, ativo imobilizado, devolução), o código padrão, se <em>gera crédito</em> e o destino financeiro. Marque uma como <strong>padrão</strong> para ela valer quando o serviço ou a compra não indicar nenhuma.</p>
      <p>O botão <strong>Criar a partir dos serviços</strong> converte as retenções já cadastradas nos serviços em tributações, e vincula cada serviço.</p>
      <h3>4. Vínculos</h3>
      <ul>
        <li><strong>Serviço (saída):</strong> no cadastro do serviço, campo <em>Tributação</em>. As retenções e o ISS retido passam a vir dela, tanto na tela de emissão quanto no XML da DPS.</li>
        <li><strong>Compra (entrada):</strong> ao importar o XML ou lançar manualmente, escolha a tributação (ou deixe a padrão).</li>
      </ul>
      <h3>5. Apuração assistida</h3>
      <p>Escolha o mês. Para cada imposto o sistema mostra <strong>débitos</strong> (notas emitidas), <strong>créditos</strong> (compras de tributações que geram crédito) e o saldo, lado a lado em <em>calculado</em> (tributação aplicada ao valor) e <em>XML</em> (o que a nota declarou, inclusive IBS e CBS). Retenções aparecem à parte. A lista de <strong>divergências</strong> aponta, documento a documento, onde o cálculo e o XML diferem em mais de R$ 0,05.</p>
      <p>O cálculo fica gravado no documento. Mudou uma tributação? Use <strong>Recalcular</strong> para refazer o mês.</p>
      <p class="dica">É uma conferência assistida, não a apuração oficial: valide sempre com o contador. O acesso é liberado por usuário (permissão <em>Tributação e apuração</em>).</p>`,
  },
  {
    id: 'despesas', titulo: 'Despesas e balanço', resumo: 'Lançar despesas e acompanhar receitas × despesas.',
    corpo: `
      <p>Em <strong>Despesas e balanço</strong> lance as despesas da empresa por categoria e acompanhe o resultado do mês: o que foi <em>recebido</em> (boletos pagos) contra o que foi gasto. Marcar as cobranças como pagas e lançar as despesas mantém o balanço confiável. O <strong>Painel do mês</strong> resume faturado, recebido, a receber, em atraso e quem ainda falta emitir. Em cada despesa informe <strong>Pago com</strong> (PIX, débito, crédito ou dinheiro): é o que permitirá vincular o gasto ao extrato para justificá-lo. As despesas vindas do extrato aparecem com a marca “extrato” e são alteradas lá, não aqui.</p>`,
  },
  {
    id: 'extrato', titulo: 'Extrato e conciliação', resumo: 'Importar o extrato em PDF, classificar e ligar aos boletos.',
    corpo: `
      <p>Hoje o sistema lê o extrato em PDF do <strong>Ailos</strong> (outros bancos entram depois).</p>
      <ol>
        <li>Em <strong>Extrato e conciliação</strong>, clique em <em>Importar extrato (PDF)</em>. O sistema confere o total lido com o saldo do próprio extrato.</li>
        <li><strong>Classifique</strong> entradas e saídas por categoria. Regras aprendem com o que você classifica e valem para lançamentos parecidos.</li>
        <li>Nas entradas, use <strong>Ligar a boleto</strong> para conciliar o recebimento com o boleto (aparecem os boletos de valor compatível, mesmo com vencimento diferente da data do crédito).</li>
        <li>O balanço do mês só fecha quando não há lançamentos sem classificação.</li>
      </ol>
      <p><strong>Ligar a despesa:</strong> numa saída, clique em <em>Ligar a despesa</em> para ligá-la a uma despesa já lançada (a parcela de uma compra, por exemplo) com o mesmo valor e data próxima. A despesa passa a ser a própria saída do extrato, sem aparecer duas vezes; <em>desfazer</em> desliga. Fluxo recomendado: lance a NF-e em <em>Compras</em> (gera despesa e parcelas) e, quando o pagamento cair no extrato, ligue.</p>
      <p><strong>Reflexo em Despesas e balanço:</strong> toda <em>saída classificada</em> vira automaticamente uma despesa (marcada como “extrato”, com o PIX/débito deduzido da descrição). Reclassificar no extrato atualiza a despesa; excluir a importação remove as despesas dela. Ficam de fora as categorias <em>Cartão de crédito</em> (os gastos entram pela própria fatura) e <em>Transferências</em>. Entradas classificadas como <em>Outras receitas</em> (sem boleto) entram nas receitas do balanço.</p>
      <p class="dica">Importar o mesmo extrato duas vezes não duplica os lançamentos. Uma importação errada pode ser excluída na lista de importações.</p>`,
  },
  {
    id: 'cartao', titulo: 'Fatura do cartão de crédito', resumo: 'Importar a fatura em PDF e levar os gastos para as despesas.',
    corpo: `
      <p>Em <strong>Financeiro &gt; Fatura do cartão</strong> importe o PDF da fatura do <strong>Ailos Cartões</strong>. O sistema lê cada compra (data, estabelecimento, cidade, parcela e final do cartão) e confere a soma com os totais impressos na própria fatura.</p>
      <ol>
        <li>Clique em <em>Importar fatura (PDF)</em>. Importar o mesmo arquivo duas vezes é recusado.</li>
        <li>Classifique cada gasto (a categoria é lembrada para compras parecidas, inclusive no extrato bancário). Anuidade e encargos já entram como <em>Tarifas e juros</em>.</li>
        <li>Os gastos classificados aparecem em <strong>Despesas e balanço</strong> como “Crédito”, no <em>mês do vencimento da fatura</em> (quando o dinheiro sai de fato), com a data da compra na descrição.</li>
      </ol>
      <p>O pagamento da fatura no extrato (categoria “Cartão de crédito”) não é contado outra vez. O pagamento da fatura anterior e créditos de estorno aparecem na lista, mas não viram despesa; um desconto de anuidade cancela a própria anuidade. Excluir a fatura remove as despesas geradas.</p>`,
  },
  {
    id: 'relatorios', titulo: 'Relatórios', resumo: 'Os relatórios disponíveis e qual data cada um usa.',
    corpo: `
      <p>A nota é emitida em um dia, o boleto vence em outro e é pago em outro. Por isso cada relatório informa <strong>qual data filtra o período</strong> e mostra as demais nas colunas.</p>
      <p>Os relatórios ficam em <strong>grupos</strong>, na lista à esquerda da tela:</p>
      <ul>
        <li><strong>Faturamento:</strong> Receitas emitidas (por data de emissão) e Faturamento por mês (notas, canceladas e recebido).</li>
        <li><strong>Contas a receber:</strong> por vencimento, em aberto por emissão, recebimentos (data do pagamento), saldo vencido por cliente (faixas de atraso), posição por cliente e prazo de recebimento por cliente (prazo e atraso médios, % pago em dia).</li>
        <li><strong>Despesas e pagamentos:</strong> despesas lançadas (com forma de pagamento e origem), por categoria, por forma de pagamento (PIX, débito, crédito, dinheiro), parcelas do cartão a vencer e compras (NF-e de entrada).</li>
        <li><strong>Fiscal e retenções:</strong> notas emitidas e tributos, livro de serviços prestados (ISS a recolher e ISS retido pelo tomador) e retenções por cliente (PIS, COFINS, CSLL, IRRF, INSS e ISS).</li>
        <li><strong>Resultado e caixa:</strong> resultado mensal (o balanço mês a mês), fluxo de caixa por categoria e pendências do extrato (sem classificação ou crédito sem boleto ligado).</li>
        <li><strong>Clientes:</strong> curva ABC (classes A, B e C pelo faturamento) e clientes sem faturamento no período.</li>
      </ul>
      <p>Clique no relatório na lista, escolha o período, o cliente e a situação (quando houver) e clique em <em>Gerar</em>. Exporte para <strong>Excel (CSV)</strong> ou <strong>PDF</strong>.</p>`,
  },
  {
    id: 'contabilidade', titulo: 'Exportar para a contabilidade', resumo: 'Pacote com extrato em OFX, PDF e XML das notas.',
    corpo: `
      <p>Em <strong>Configurações &gt; Contabilidade</strong> (administrador) escolha a empresa e o mês. O sistema gera um pacote ZIP com o extrato convertido em <strong>OFX</strong>, o extrato em <strong>PDF</strong> e os <strong>XML</strong> de todas as notas emitidas no período, pronto para enviar ao contador.</p>
      <p>Marque o que vai no pacote: notas emitidas (XML e PDF), <strong>notas de entrada lançadas em Compras</strong>, <strong>notas recebidas da SEFAZ ainda não lançadas</strong> e o extrato em OFX. As entradas vão em <code>entradas/xml</code> com uma planilha (fornecedor, valor, chave, parcelas); as não lançadas e as canceladas pelo fornecedor vêm marcadas.</p>
      <h3>Fechamento mensal automático</h3>
      <p>Na mesma tela, informe o <strong>e-mail da contabilidade</strong> (até 5), ligue <em>Enviar automaticamente todo mês</em> e escolha o <strong>dia</strong>. Nesse dia o sistema envia sozinho, em anexo, o pacote completo do <strong>mês anterior</strong>. Usa o e-mail do escritório configurado em <em>E-mail</em>. Se o sistema estiver fechado no dia, envia na primeira vez que for aberto depois; se falhar, tenta de novo em 6 horas e mostra o motivo. <em>Enviar agora</em> dispara qualquer mês na hora. Pacotes acima de 20 MB não vão por e-mail.</p>`,
  },
  {
    id: 'configuracoes', titulo: 'Configurações', resumo: 'Usuários, e-mail, aparência, backup, licença e atualizações.',
    corpo: `
      <ul>
        <li><strong>Minha conta:</strong> altere sua senha.</li>
        <li><strong>Usuários e acessos</strong> (administrador): crie usuários e libere por usuário as funcionalidades (emissão, notas, cobranças, relatórios etc.) e as empresas que cada um enxerga. A permissão <strong>Excluir registros</strong> é separada das demais: sem ela o usuário não vê nem consegue usar nenhuma exclusão (nota não autorizada, serviço, despesa, importação de extrato), mesmo tendo acesso à tela. O administrador sempre pode.</li>
        <li><strong>E-mail:</strong> servidor SMTP usado para enviar notas e boletos aos clientes e para a recuperação de senha.</li>
        <li><strong>Aparência:</strong> escolha entre <em>Preto e laranja</em>, <em>Branco e laranja</em> e <em>Azul e dourado</em>. Vale para o computador.</li>
        <li><strong>Backup:</strong> o sistema faz cópia automática diária; também dá para baixar um backup quando quiser. Guarde uma cópia fora do computador.</li>
        <li><strong>Licença:</strong> mostra a situação e permite informar um novo código. Nos <strong>15 dias</strong> antes do vencimento (da licença ou do período de teste) o menu mostra "Licença vence em N dia(s)" em destaque e o sistema abre um aviso uma vez por dia, com o código do computador para pedir a renovação. Vencida a licença, só a emissão é bloqueada.</li>
        <li><strong>Atualizações:</strong> o sistema baixa novas versões e pede para reiniciar; os dados são preservados.</li>
      </ul>`,
  },
  {
    id: 'atalhos', titulo: 'Atalhos e dicas', resumo: 'Atalhos de teclado e boas práticas.',
    corpo: `
      <p><strong>Menu:</strong> as telas ficam em grupos (Faturamento, Compras, Financeiro, Cadastros). Clique no nome do grupo para abrir ou recolher; o grupo da tela atual abre sozinho.</p>
      <ul>
        <li>Em Emitir nota, digite no campo do cliente para buscar na hora; <kbd>F2</kbd> abre a consulta completa (setas, Enter para escolher, Esc para fechar).</li>
        <li>Confira sempre a <strong>empresa selecionada</strong> no alto do menu antes de emitir.</li>
        <li>Teste primeiro em <em>Produção restrita</em>.</li>
        <li>Mantenha backup fora do computador e renove o certificado A1 antes do vencimento.</li>
      </ul>`,
  },
  {
    id: 'problemas', titulo: 'Problemas comuns', resumo: 'O que fazer nos erros mais frequentes.',
    corpo: `
      <dl class="faq">
        <dt>"Cadastre o certificado A1 da empresa antes de emitir"</dt><dd>Envie o certificado em Empresas &gt; Certificado, ou mude a empresa para o modo Portal se ela emite sem certificado.</dd>
        <dt>Nota rejeitada</dt><dd>Leia o código e o motivo na tela da nota, corrija os dados em <em>Corrigir e reenviar</em>. Se não for possível corrigir, exclua a nota rejeitada e emita outra.</dd>
        <dt>A Sefin não respondeu</dt><dd>Use <em>Consultar na Sefin</em> na nota. Se ela existir, é recuperada; senão, reenvie.</dd>
        <dt>Não consigo gerar boleto</dt><dd>Falta preencher os Dados bancários da empresa (Empresas &gt; Dados bancários).</dd>
        <dt>Não encontro uma opção no menu</dt><dd>Seu usuário pode não ter a permissão; peça ao administrador em Configurações &gt; Usuários e acessos.</dd>
        <dt>Extrato não confere</dt><dd>O sistema compara o total lido com o do PDF e avisa a diferença; confirme se o PDF é do Ailos e do período completo.</dd>
      </dl>`,
  },
];
