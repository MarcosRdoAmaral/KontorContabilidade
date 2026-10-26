# Kontor Gestão Contabilidade

Sistema de gestão para **escritórios de contabilidade**, derivado do [Kontor Gestão](https://github.com/MarcosRdoAmaral/Kontorgestao).
Os dois projetos seguem em paralelo: este repositório é uma cópia independente, com nome, pasta de dados (`%APPDATA%\Kontor Gestão Contabilidade`),
porta local (38246), instalador, licença e atualizações próprios — os dois aplicativos podem ser instalados no mesmo computador.

## Gestão do escritório (novo)
- **Visão geral**: clientes por regime, obrigações do mês, atrasadas, certificados vencendo, honorários e carga da equipe.
- **Carteira de clientes**: regime (MEI, Simples, Presumido, Real, imune, PF), responsável, situação, contato e perfil (empregados, ICMS, ISS). Busca na Receita pelo CNPJ.
- **Obrigações e prazos**: catálogo editável (DAS, DCTFWeb, eSocial, FGTS Digital, EFD-Reinf, EFD-Contribuições, IRPJ/CSLL, ECD, ECF, EFD ICMS/IPI, ISS, 13º…) com regras de vencimento (dia fixo com antecipa/adia, último dia útil, N-ésimo dia útil, com ou sem sábado) e feriados; tarefas por cliente e competência com responsável, protocolo, dispensa com motivo e entrega em lote; exceções por cliente. `src/servicos/obrigacoes.ts`.
- **Certificados e procurações**: A1 do sistema + A3, e-CPF e procurações cadastrados, com situação e renovação. `src/servicos/certificados.ts`.
- **Contratos e honorários**: modelos com campos `{{...}}`, PDF do contrato, via assinada, e o contrato assinado liga o faturamento automático (NFS-e e/ou boleto Ailos) na empresa do escritório; reajuste por IPCA/IGP-M/INPC (Banco Central, SGS) ou percentual fixo; 13º honorário; inadimplência. `src/servicos/honorarios.ts`.
- **Captura de documentos**: NF-e recebidas de todos os clientes (Distribuição DF-e) e pacote ZIP do mês por cliente. `src/servicos/captura.ts`.
- **Avisos**: resumo diário por e-mail de atrasos, vencimentos, certificados e reajustes. `src/servicos/avisos.ts`.

Rotas em `src/rotas-escritorio.ts`, permissões (módulos visao, carteira, obrigacoes, certificados, honorarios, captura) em `src/auth.ts`, telas no fim de `public/app.js`, testes em `test/escritorio.test.ts`.

> Os prazos do catálogo seguem a legislação conhecida em 2026, mas devem ser conferidos pelo escritório (e ajustados no catálogo) — principalmente ISS e ICMS, que variam por local.

---

Tudo abaixo é herdado do Kontor Gestão e continua valendo.

## Aplicativo de Windows
- Instalação com "próximo, próximo, concluir", **sem pedir senha de administrador** (instala na pasta do usuário).
- Banco SQLite local em `%APPDATA%\Kontor Gestão\dados`. Desinstalar **não apaga** os dados.
- No primeiro uso, tela de boas-vindas cria o escritório e o administrador.
- A chave que protege os certificados A1 fica no **cofre do Windows (DPAPI)**, atrelada ao usuário do computador.
- Backup automático diário (últimos 30) + botão "Baixar backup" + menu Arquivo > Salvar/Restaurar backup.
- O servidor interno escuta só em `127.0.0.1`: nada é exposto na rede.

### Gerar o instalador
```bash
npm install
npm run dist          # build + instalador (usa makensis, não precisa de Windows nem wine)
```
Saída: `release/Kontor-Gestao-Instalador-<versão>.exe`.
Para o instalador oficial do electron-builder (ícone embutido pelo rcedit, assinatura de código), use o workflow
`.github/workflows/instalador-windows.yml` (Actions > Instalador Windows > Run workflow).

### Testar sem instalar
```bash
npm run desktop       # abre o app em modo desenvolvimento
```

## O que o sistema faz
- Cadastro de empresas, tomadores e serviços; certificado A1 por empresa (AES-256-GCM em repouso).
- Emissão: monta a DPS na ordem do XSD, assina (XMLDSig RSA-SHA1, C14N), envia por mTLS e arquiva o XML.
- Numeração de DPS atômica; a nota é gravada **antes** do envio. Se a conexão cair, "Consultar na Sefin" recupera a nota sem duplicar.
- Rejeições mostram código e texto da Sefin; corrigir e reenviar mantém o mesmo número de DPS.
- DANFSe em PDF gerado localmente, download do XML, cancelamento (evento e101101), painel mensal.
- Perfis: administrador, operador, cliente (vê só as empresas vinculadas). CNPJ alfanumérico; grupo IBS/CBS opcional por serviço.

## Servidor
```bash
cp .env.example .env     # MASTER_KEY, SESSION_SECRET (e ADMIN_SENHA, ou use a tela de boas-vindas)
npm run dev              # http://localhost:3000
npm test
```
Produção: `npm run build && npm start` atrás de HTTPS. **Guarde a MASTER_KEY**: sem ela os certificados salvos não abrem.

## Antes de emitir de verdade
1. Cadastre a empresa em **produção restrita** (padrão) e emita notas de teste com o certificado real.
2. Confirme que o município é aderente ao Emissor Nacional e os códigos aceitos (cTribNac de 6 dígitos, desdobro cTribMun).
3. Só então troque a empresa para Produção.

## Limites conhecidos
- Testado contra uma Sefin simulada que valida o XML nos XSDs oficiais 1.01; **não foi testado contra a Sefin real** (exige certificado ICP-Brasil).
- O instalador foi gerado e o app empacotado foi executado em Linux (Electron); **a instalação em Windows ainda não foi testada**.
- Sem atualização automática: novas versões são distribuídas reinstalando por cima (os dados são mantidos).
- Dados presos ao computador: cada instalação tem o seu banco. Para vários usuários compartilhando as mesmas notas, usar o modo servidor.
- Ainda não há: tomador estrangeiro, obra, substituição de NFS-e, dedução/redução, consulta de notas tomadas (ADN).

## Lista nacional de serviços

`public/servicos-nacionais.json` contém os 338 códigos de tributação nacional (cTribNac) extraídos do
Anexo B oficial (`anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx`). No cadastro de
serviço há uma busca por código ou texto que preenche o código nacional, a descrição e o nome.
A alíquota **não** é preenchida automaticamente: confirme a alíquota/habilitação do serviço no
município (Blumenau) antes de emitir.

## Retenções, IBS/CBS, logo e lote (1.0.2)

- Emissão: retenções federais PIS, COFINS, CSLL, IRRF e INSS/CP (grupo `piscofins` + `tpRetPisCofins` calculado).
- IBS/CBS: CST com 3 dígitos (ex.: 000), cClassTrib e cIndOp com 6. Exige endereço completo do tomador (E0234).
- Logo por empresa (Empresas → Logo): aparece no cabeçalho do DANFSe.
- Notas emitidas → Baixar em lote: ZIP com XML e/ou PDF.

## Atualização automática (GitHub Releases)

1. Crie um repositório no GitHub (as releases precisam ser públicas para os computadores baixarem sem login) e
   preencha `"kontor": { "repositorioAtualizacoes": "usuario/repositorio" }` no `package.json`.
2. Para publicar: aumente `version` no `package.json`, faça o commit e crie a tag `vX.Y.Z` (`git tag v1.0.7 && git push origin v1.0.7`).
   O fluxo `.github/workflows/instalador-windows.yml` testa, gera o instalador e cria a release com o `.exe` e o `.sha256`.
3. O aplicativo verifica ao abrir e a cada 6 horas (e em Ajuda → Verificar atualizações). Ao aceitar, faz a cópia de
   segurança dos dados, baixa o instalador, confere o SHA-256 e o abre. Os dados não são alterados.
Observação: o instalador não é assinado digitalmente; o Windows SmartScreen pode avisar na primeira execução.

## E-mail da NFS-e e aviso de versão (1.0.11)

- Menu **E-mail**: configure o SMTP do escritório (Gmail/Outlook usam senha de aplicativo). A senha fica criptografada.
- Na nota (Produção): **Enviar por e-mail** manda o PDF (DANFSe) e o XML. Na emissão, a caixa "Enviar por e-mail ao tomador"
  envia automaticamente quando autorizar. O histórico de envios aparece na nota.
- Quando sai uma versão nova, uma faixa fixa no topo da tela avisa ("Atualizar agora" / "Depois").

## Cancelamento por e-mail e WhatsApp (1.0.12)

- Ao cancelar, a caixa "Avisar o tomador por e-mail" envia o PDF (marcado CANCELADA) e os XMLs da nota e do cancelamento.
- **Enviar por WhatsApp** abre o WhatsApp com a mensagem pronta e o link da nota no portal nacional (o PDF pode ser baixado e anexado à conversa).

## Versão 1.0.13 – Faturamento por cliente e controle de licença

**Cadastro do cliente (tomador)** agora tem a seção *Faturamento e cobrança*: somente nota, nota + boleto ou somente boleto; vencimento por prazo (N dias) ou dia fixo do mês; e-mails extras de cobrança; envio automático por e-mail.

**Um comando:** ao emitir, a ação padrão vem do cadastro do cliente (pode ser trocada na hora). `POST /api/faturar` emite a nota, registra a cobrança e envia o e-mail. O boleto fica *aguardando banco* até a integração bancária ser ligada (tela **Cobranças**).

**Licença:** teste automático de 30 dias; depois, código de ativação por computador (renovação a cada 3 meses). Vencida = só a emissão é bloqueada. Menu **Licença** mostra o código do computador.

### Como ativar o controle de licença (dono do sistema)
1. Abra `ferramentas/gerador-de-licencas.html` no navegador (offline) e clique em *Gerar chaves*. Guarde a **chave privada**; nunca a compartilhe.
2. Coloque a **chave pública** em `src/licenca-chave.ts` e publique uma nova versão. Enquanto estiver vazia, o controle fica desligado.
3. Para cada renovação: o cliente envia o código do computador; você informa nome e validade (padrão 3 meses) e envia o código `KG1.…` gerado.

## Versão 1.0.14 – Controle de licença ativado
Chave pública de licenciamento configurada: teste de 30 dias a partir do primeiro uso após a atualização e, depois, código de ativação por computador.

## Versão 2.0.0
Marco da versão 2: emissão de NFS-e nacional, faturamento por cliente (nota / nota + boleto / só boleto), envio por e-mail e WhatsApp, atualização automática e controle de licença por computador. A integração bancária dos boletos é a próxima etapa.

## Versão 2.1.0 – Boletos Ailos (CNAB 240)
- **Dados bancários** por empresa (agência, conta, convênio, carteira, multa e juros) e boleto em PDF no padrão Ailos 085 (nosso número, código de barras ITF e linha digitável conferidos com o exemplo do manual).
- **Um comando:** *Nota + boleto* emite a nota, gera o boleto e envia nota (PDF/XML) e boleto por e-mail. *Somente boleto* gera e envia só o boleto.
- **Remessa CNAB 240** (segmentos P, Q e R) gerada na tela **Cobranças**; envie o arquivo no Ailos Conta Online. **Retorno** (segmentos T e U): importe o arquivo para registrar entradas, rejeições, liquidações e baixas automaticamente.
- Cancelar um boleto já enviado gera pedido de baixa na próxima remessa. O número do boleto e da remessa nunca retrocedem.
- O cadastro do cliente passou a ter cidade e UF (necessários ao boleto); o sistema avisa antes de emitir a nota se faltar algum dado.

## Acesso e permissões (v2.3.0)

- Login por **usuário** (sempre em maiúsculas), definido na criação. Há dois perfis: **Administrador** (acesso total, cria usuários e redefine senhas) e **Normal** (só as funcionalidades marcadas e, opcionalmente, só as empresas marcadas). As regras são aplicadas no servidor (`src/auth.ts`, lista `REGRAS`), não só no menu.
- Usuário **master** `KONTOR`: criado após o primeiro acesso, administrador que nenhum outro usuário altera ou redefine.
- Senha padrão `Kontor2026`: usada quando um administrador redefine a senha ou o usuário é criado sem senha; a troca é obrigatória no próximo acesso.
- "Esqueci minha senha": envia um código de 6 dígitos (15 min) ao e-mail do usuário, usando o SMTP configurado em Configurações > E-mail; ao confirmar o código a senha volta à padrão.
- **Configurações** reúne Minha conta, Usuários e acessos, E-mail, Backup, Licença e Atualizações (busca automática ao abrir, a cada hora e ao voltar à janela, com botão "Verificar agora").

## Manual do usuário
O manual fica em **Relatórios > Documentação** e é escrito em `public/manual.js`. Toda funcionalidade nova ou alterada deve atualizar o tópico correspondente e o `MANUAL_VERSAO` (o teste `test/manual.test.ts` falha se a versão do manual ficar diferente da do `package.json`).
