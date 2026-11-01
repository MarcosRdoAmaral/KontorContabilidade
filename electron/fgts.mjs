// Consulta ao FGTS Digital (portal do empregador) pelo aplicativo instalado.
// Não há API pública: o usuário entra no portal numa janela do Kontor, com o certificado digital do escritório
// (gov.br), e o Kontor usa as mesmas telas do portal para, cliente a cliente, definir o perfil "Procurador" e ler as
// competências em aberto (Emissão de Guia Rápida). Nada é emitido nem alterado no portal.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, session } from 'electron';

const ORIGEM = 'https://fgtsdigital.sistema.gov.br';
const PARTICAO = 'persist:fgts-digital';
let janelaFgts = null;
// certificado escolhido para o FGTS: lembrado entre aberturas do programa (só o fingerprint, nunca a chave)
const arqCert = () => path.join(app.getPath('userData'), 'fgts-certificado.json');
let certificadoEscolhido; // lido na primeira vez que o gov.br pede o certificado
const certificadoSalvo = () => { if (certificadoEscolhido === undefined) { try { certificadoEscolhido = JSON.parse(fs.readFileSync(arqCert(), 'utf8')).fingerprint ?? null; } catch { certificadoEscolhido = null; } } return certificadoEscolhido; };
const lembrarCertificado = (fp) => { certificadoEscolhido = fp; try { fs.writeFileSync(arqCert(), JSON.stringify({ fingerprint: fp })); } catch { /* só nesta abertura */ } };

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Certificado do login gov.br: sem isto o Electron usaria o primeiro certificado instalado, sem perguntar.
app.on('select-client-certificate', async (event, webContents, url, lista, callback) => {
  if (!janelaFgts || janelaFgts.isDestroyed() || webContents !== janelaFgts.webContents) return;
  event.preventDefault();
  const salvo = lista.find((c) => c.fingerprint === certificadoSalvo());
  if (salvo) return callback(salvo);
  if (!lista.length) return callback();
  if (lista.length === 1) { lembrarCertificado(lista[0].fingerprint); return callback(lista[0]); }
  const nomes = lista.map((c) => `${c.subjectName}${c.validExpiry ? ` (válido até ${new Date(c.validExpiry * 1000).toLocaleDateString('pt-BR')})` : ''}`);
  const r = await dialog.showMessageBox(janelaFgts, {
    type: 'question', title: 'Certificado digital', message: 'Escolha o certificado para entrar no FGTS Digital',
    detail: 'Use o certificado do escritório (e-CNPJ): o Kontor consulta os clientes como procurador.', buttons: [...nomes, 'Cancelar'], cancelId: nomes.length, noLink: true,
  });
  if (r.response >= lista.length) return callback();
  lembrarCertificado(lista[r.response].fingerprint);
  callback(lista[r.response]);
});

function janela(pai) {
  if (janelaFgts && !janelaFgts.isDestroyed()) return janelaFgts;
  janelaFgts = new BrowserWindow({
    width: 1100, height: 820, parent: pai, title: 'FGTS Digital — Kontor', autoHideMenuBar: true,
    webPreferences: { partition: PARTICAO, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  janelaFgts.loadURL(`${ORIGEM}/portal/`);
  janelaFgts.on('closed', () => { janelaFgts = null; });
  return janelaFgts;
}

async function cookies() {
  const l = await session.fromPartition(PARTICAO).cookies.get({ url: ORIGEM });
  return Object.fromEntries(l.map((c) => [c.name, decodeURIComponent(c.value)]));
}

/** Logado = há token ainda válido (a sessão do portal dura cerca de 30 minutos). */
async function logado() {
  const t = (await cookies()).fgtsd_token;
  if (!t) return false;
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000 > Date.now() + 60e3; } catch { return true; }
}

const js = (w, codigo) => w.webContents.executeJavaScript(`(async () => { ${codigo} })()`, true);

/** Abre a janela e espera o usuário entrar com o certificado (até 10 minutos). */
async function esperarLogin(pai, aoAvisar) {
  const w = janela(pai);
  w.show(); w.focus();
  if (await logado()) return w;
  aoAvisar?.({ etapa: 'login', mensagem: 'Entrando no FGTS Digital pelo gov.br com certificado digital. Quando aparecer a lista, escolha o certificado do escritório (e-CNPJ).' });
  // o Kontor clica sozinho em "Entrar com GOV.BR" e em "Seu certificado digital"; a escolha do certificado fica com o usuário
  const clicados = new Set();
  const fim = Date.now() + 10 * 60e3;
  while (Date.now() < fim) {
    if (!janelaFgts || janelaFgts.isDestroyed()) throw new Error('A janela do FGTS Digital foi fechada.');
    if (await logado()) return w;
    try {
      const url = w.webContents.getURL();
      const chave = url.includes('acesso.gov.br') ? 'govbr' : url.startsWith(ORIGEM) ? 'portal' : null;
      if (chave && !clicados.has(chave)) {
        const ok = await js(w, chave === 'portal'
          ? `const b = [...document.querySelectorAll('button, a')].find((x) => /entrar com gov\\.?br/i.test(x.textContent)); if (!b) return false; b.click(); return true;`
          : `const l = [...document.querySelectorAll('a, button, li, [role=button], [tabindex]')].filter((x) => /seu certificado digital/i.test(x.textContent) && !/nuvem/i.test(x.textContent));
             const b = l.sort((x, y) => x.textContent.length - y.textContent.length)[0]; if (!b) return false; (b.closest('a, button') ?? b).click(); return true;`);
        if (ok) clicados.add(chave);
      }
    } catch { /* página ainda carregando */ }
    await dormir(1500);
  }
  throw new Error('O login no FGTS Digital não foi concluído em 10 minutos.');
}

// Ajudantes que rodam dentro da página do portal (o campo do CNPJ e a caixa "Trocar Perfil" são redesenhados pelo portal).
const AJUDANTES = `
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const visivel = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const campoNi = () => { const l = [...document.querySelectorAll('input[placeholder*="CNPJ" i], input[placeholder*="CPF" i]')]; return l.find(visivel) ?? l[0] ?? null; };
  const caixa = () => campoNi()?.closest('[role=dialog], .modal, .br-modal, mat-dialog-container, .cdk-overlay-pane, form') ?? document;
  const seletorPerfil = () => caixa().querySelector('select, ng-select, .br-select, [role=combobox], [aria-haspopup=listbox]');
  const perfilAtual = () => {
    const el = seletorPerfil(); if (!el) return '';
    if (el.tagName === 'SELECT') return el.selectedOptions[0]?.textContent?.trim() ?? '';
    const inp = el.matches('input') ? el : el.querySelector('input');
    return (el.querySelector('.ng-value-label, .ng-value, .br-tag')?.textContent || inp?.value || '').trim();
  };
  const ehProcurador = (t) => /^\\s*procurador\\s*$/i.test(t ?? '');
  const alerta = () => [...document.querySelectorAll('[role=alert], .br-message.danger, .br-message.is-danger, .mensagem-erro, .alert-danger')].filter(visivel)
    .map((x) => x.textContent.replace(/\\s+/g, ' ').replace(/^\\s*Mensagem de Erro\\s*/i, '').replace(/Fechar\\s*$/i, '').trim()).find(Boolean) ?? '';
`;

const fmtNi = (ni) => (ni.length === 14 ? ni.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : ni.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'));

/** O perfil já é o de procurador deste cliente? (cookies do portal, também os que a página não lê). */
async function perfilConfirmado(ni, w) {
  const c = await cookies();
  if (c.fgtsd_tipo_perfil === '2' && String(c.fgtsd_ni_perfil ?? '').replace(/\D/g, '') === ni) return true;
  // reserva: o cabeçalho do portal mostra "Empregador: <CNPJ> | NOME" e "Usuário (Procurador): ..." sem a caixa aberta
  if (!w || w.isDestroyed()) return false;
  return js(w, `${AJUDANTES}
    const t = document.body?.innerText ?? '';
    const emp = (t.match(/Empregador:\\s*([\\d./-]+)/) ?? [])[1]?.replace(/\\D/g, '');
    const caixaAberta = [...document.querySelectorAll('[role=dialog], .br-modal, mat-dialog-container')].some(visivel);
    return emp === ${JSON.stringify(ni)} && /Usu[aá]rio\\s*\\(Procurador\\)/i.test(t) && !caixaAberta;`).catch(() => false);
}

/** Tenta preencher a caixa "Trocar Perfil" sozinho: escolhe Procurador, digita o CNPJ/CPF e clica em Selecionar. */
async function preencherPerfil(w, ni) {
  // 1) caixa aberta (se não abrir sozinha, usa o botão "Trocar Perfil")
  const aberta = await js(w, `${AJUDANTES}
    for (let i = 0; i < 40 && !campoNi(); i++) {
      if (i === 6 || i === 20) [...document.querySelectorAll('button, a')].find((b) => /trocar perfil/i.test(b.textContent))?.click();
      await espera(250);
    }
    return !!campoNi();`);
  if (!aberta) return { ok: false, motivo: 'a caixa Trocar Perfil não abriu' };
  // 2) perfil Procurador
  const perfil = await js(w, `${AJUDANTES}
    if (!ehProcurador(perfilAtual())) {
      const el = seletorPerfil();
      if (el?.tagName === 'SELECT') {
        const op = [...el.options].find((o) => ehProcurador(o.textContent));
        if (op) { el.value = op.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el) {
        const alvoClique = [el.querySelector('input'), el.querySelector('button'), el.querySelector('.ng-arrow-wrapper'), el].filter(Boolean);
        for (const x of alvoClique) { x.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); x.click(); await espera(200); if ([...document.querySelectorAll('.ng-option, [role=option], .br-item, mat-option')].some(visivel)) break; }
        for (let i = 0; i < 20; i++) {
          const op = [...document.querySelectorAll('.ng-option, [role=option], .br-item, mat-option, .br-list li, li')].filter(visivel).find((o) => ehProcurador(o.textContent));
          if (op) { const r = op.querySelector('input[type=radio], input[type=checkbox]'); (r ?? op).click(); if (r) op.querySelector('label')?.click(); break; }
          await espera(150);
        }
      }
      await espera(400);
    }
    const ni = campoNi();
    for (let i = 0; i < 20 && ni && ni.disabled; i++) await espera(150);
    return { perfil: perfilAtual(), campo: !!campoNi() && !campoNi().disabled };`);
  if (!perfil?.campo) return { ok: false, motivo: `não consegui escolher o perfil Procurador (aparece "${perfil?.perfil || 'vazio'}")` };
  // 3) CNPJ/CPF: digitação de verdade (a máscara do campo reage ao teclado); se não pegar, grava o valor no campo
  w.focus(); w.webContents.focus();
  await js(w, `${AJUDANTES} const ni = campoNi(); ni.focus(); ni.click(); ni.select?.(); return true;`);
  await w.webContents.insertText(ni);
  await dormir(300);
  let digitado = await js(w, `${AJUDANTES} return (campoNi()?.value ?? '').replace(/\\D/g, '');`);
  if (digitado !== ni) {
    await js(w, `${AJUDANTES} const ni = campoNi(); ni.focus(); ni.select?.(); return true;`);
    for (const ch of ni) {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    }
    await dormir(300);
    digitado = await js(w, `${AJUDANTES}
      const ni = campoNi(), alvo = ${JSON.stringify(ni)};
      if (ni.value.replace(/\\D/g, '') !== alvo) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(ni, ${JSON.stringify(fmtNi(ni))}); ni.dispatchEvent(new Event('input', { bubbles: true })); ni.dispatchEvent(new Event('change', { bubbles: true }));
        await espera(200);
      }
      ni.dispatchEvent(new Event('blur', { bubbles: true }));
      return ni.value.replace(/\\D/g, '');`);
  }
  if (digitado !== ni) return { ok: false, motivo: 'o campo do CNPJ não aceitou o número' };
  // 4) Selecionar e esperar o portal confirmar
  // botão Selecionar: procura subindo a partir do campo (o rodapé da caixa fica fora do formulário) e, por último, na página
  const clicou = await js(w, `${AJUDANTES}
    const eh = (b) => visivel(b) && !b.disabled && /^\\s*(selecionar|definir|confirmar)\\s*$/i.test(b.textContent);
    campoNi()?.dispatchEvent(new Event('blur', { bubbles: true }));
    for (let i = 0; i < 20; i++) {
      let el = campoNi(), b = null;
      while (el && !b) { b = [...el.querySelectorAll?.('button') ?? []].find(eh) ?? null; el = el.parentElement; }
      b ??= [...document.querySelectorAll('button')].find(eh);
      if (b) { b.click(); return true; }
      await espera(150);
    }
    return false;`);
  if (!clicou) return { ok: false, motivo: 'não encontrei o botão Selecionar' };
  for (let i = 0; i < 60; i++) {
    await dormir(250);
    if (await perfilConfirmado(ni, w)) return { ok: true };
    const erro = await js(w, `${AJUDANTES} return alerta();`).catch(() => '');
    if (erro) return { ok: false, erro };
  }
  return { ok: false, motivo: 'o portal não confirmou a troca de perfil' };
}

/**
 * Define o perfil "Procurador" para o CNPJ/CPF do cliente. Se o preenchimento automático não der certo (o portal muda de
 * tela de vez em quando), pede para o usuário fazer na janela, com o CNPJ já copiado, e segue sozinho depois.
 */
async function definirProcurador(w, ni, cliente, aoAvisar) {
  ni = String(ni).replace(/\D/g, '');
  await w.loadURL(`${ORIGEM}/portal/escolhaPerfil`);
  let r;
  try { r = await preencherPerfil(w, ni); } catch (e) { r = { ok: false, motivo: String(e?.message ?? e) }; }
  if (r.ok || r.erro) return r;
  // modo assistido
  clipboard.writeText(fmtNi(ni));
  if (!janelaFgts || janelaFgts.isDestroyed()) throw new Error('A janela do FGTS Digital foi fechada.');
  w.show(); w.focus();
  aoAvisar?.({ etapa: 'manual', cliente, mensagem: `Não consegui trocar o perfil sozinho (${r.motivo}). Na janela do FGTS Digital, em "Trocar Perfil", escolha Procurador, cole o CNPJ ${fmtNi(ni)} (${cliente}) — ele já está copiado — e clique em Selecionar. O Kontor continua sozinho em seguida.` });
  const fim = Date.now() + 3 * 60e3;
  while (Date.now() < fim) {
    if (!janelaFgts || janelaFgts.isDestroyed()) throw new Error('A janela do FGTS Digital foi fechada.');
    if (await perfilConfirmado(ni, w)) return { ok: true };
    const erro = await js(w, `${AJUDANTES} return alerta();`).catch(() => '');
    if (erro) return { ok: false, erro };
    await dormir(1000);
  }
  return { ok: false, erro: 'A troca de perfil não foi feita em 3 minutos. Consulte este cliente de novo.' };
}

/** Competências em aberto do perfil atual (Emissão de Guia Rápida), com os valores para pagamento hoje. */
async function lerCompetencias(w) {
  return js(w, `
    const get = async (u) => { const r = await fetch(u, { credentials: 'include' }); const t = await r.text(); if (!r.ok) throw new Error(t.trim() || ('HTTP ' + r.status)); try { return JSON.parse(t); } catch { return t; } };
    const lista = await get('/cobranca/api/guia-rapida/');
    const abertas = (Array.isArray(lista) ? lista : []).filter((c) => /aberta/i.test(c.status ?? ''));
    const competencias = [];
    for (const c of abertas) {
      try {
        const d = await get('/cobranca/api/guia-rapida/v2/' + c.id + '?mensal=true&rescisorio=true&processoTrabalhista=true&consignado=false');
        const det = (d?.agrupamentos ?? []).flatMap((a) => (a.detalhamentos ?? []).map((x) => ({ tipo: a.tipo, ...x })));
        competencias.push({ id: c.id, competencia: c.competencia, total: d?.resumo?.vlTotal ?? det.reduce((t, x) => t + (x.vlTotal ?? 0), 0), detalhes: det });
      } catch (e) { competencias.push({ id: c.id, competencia: c.competencia, total: c.vlTotal ?? null, erro: String(e.message ?? e) }); }
    }
    let notificacao = null;
    try { notificacao = (await get('/cobranca/api/folha/verificar-notificacao-debito')) === true; } catch {}
    return { competencias, notificacao };`);
}

/** Consulta a lista de clientes; `aoAvisar` recebe o andamento. Devolve um resultado por cliente. */
export async function consultarFgts(pai, clientes, aoAvisar) {
  const w = await esperarLogin(pai, aoAvisar);
  const resultados = [];
  for (const [i, c] of clientes.entries()) {
    aoAvisar?.({ etapa: 'cliente', atual: i + 1, total: clientes.length, cliente: c.nome });
    try {
      if (!(await logado())) throw new Error('A sessão do FGTS Digital expirou. Entre de novo e consulte os clientes que faltaram.');
      const p = await definirProcurador(w, c.documento, c.nome, aoAvisar);
      if (!p.ok) { resultados.push({ empresa_id: c.id, situacao: /procura/i.test(p.erro ?? '') ? 'SEM_PROCURACAO' : 'ERRO', mensagem: p.erro ?? p.motivo }); continue; }
      const d = await lerCompetencias(w);
      const total = Math.round(d.competencias.reduce((t, x) => t + (x.total ?? 0), 0) * 100) / 100;
      resultados.push({ empresa_id: c.id, situacao: d.competencias.length ? 'EM_ABERTO' : 'EM_DIA', total, competencias: d.competencias, notificacao: d.notificacao, mensagem: null });
    } catch (e) {
      resultados.push({ empresa_id: c.id, situacao: 'ERRO', mensagem: String(e?.message ?? e) });
      if (/fechada|expirou/i.test(String(e?.message))) break;
    }
  }
  return resultados;
}

/**
 * Guia (emitida ou recalculada) ou recibo do FGTS Digital: entra no perfil do cliente como procurador, leva o usuário
 * à tela certa e guarda o primeiro PDF que o portal baixar. Quem escolhe a competência e a data de pagamento é o
 * usuário, no próprio portal (é ali que o FGTS Digital recalcula encargos para outra data).
 */
/** Clica no elemento visível cujo texto (ou aria-label/title) bate com a expressão; o menor texto ganha. */
const CLICAR = (re, onde = 'document') => `const re = ${re}; const raiz = ${onde}; if (!raiz) return false;
  const vis = (x) => !!(x.offsetWidth || x.offsetHeight || x.getClientRects().length);
  const txt = (x) => ((x.textContent || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '')).replace(/\\s+/g, ' ').trim();
  const l = [...raiz.querySelectorAll('button, a, [role=button], [role=option], li, .card, .br-card, h2, h3, h4, h5, p, span, div')].filter((x) => vis(x) && re.test(txt(x)) && txt(x).length < 70);
  const fundo = (x) => { let n = 0; for (let p = x; p; p = p.parentElement) n++; return n; };
  // menor texto; no empate, o elemento mais interno (o clique sobe até o card ou botão que trata o evento)
  const b = l.sort((x, y) => txt(x).length - txt(y).length || fundo(y) - fundo(x))[0]; if (!b) return false;
  b.scrollIntoView({ block: 'center' }); b.click(); return true;`;

async function esperar(w, codigo, ms = 20000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (!janelaFgts || janelaFgts.isDestroyed()) throw new Error('janela fechada');
    try { const r = await js(w, codigo); if (r) return r; } catch { /* página trocando */ }
    await dormir(600);
  }
  return false;
}
const texto = (re) => `return ${re}.test(document.body.innerText || '');`;

/** Ícone PDF (ao lado de "FGTS") da guia mostrada: sobe do título "Vencimento da Guia" até achar o botão. */
const PDF_DA_SECAO = `const vis = (x) => !!(x.offsetWidth || x.offsetHeight);
  const ehPdf = (x) => vis(x) && /pdf/i.test((x.textContent || '') + (x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '') + (x.querySelector('img')?.alt || '') + (x.querySelector('img')?.src || '') + (/pdf/i.test(x.innerHTML) ? 'pdf' : ''));
  const h = [...document.querySelectorAll('h1, h2, h3, h4, h5, div, span')].filter((x) => vis(x) && /Vencimento da Guia/i.test(x.textContent || '') && (x.textContent || '').length < 80)
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  for (let s = h; s; s = s.parentElement) { const b = [...s.querySelectorAll('button, a')].find(ehPdf); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; } }
  return false;`;

async function emitirNaGuiaRapida(w, competencia, tipo, dataPagamento, aoAvisar) {
  if (!competencia) return { ok: false, passo: 'competência não informada' };
  const [aaaa, mm] = competencia.split('-'), comp = `${mm}/${aaaa}`;
  aoAvisar?.({ etapa: 'documento', mensagem: `Abrindo a Emissão de Guia Rápida (${comp})…` });
  if (!(await js(w, texto('/Compet[eê]ncia de Apura[cç][aã]o/i')).catch(() => false))) {
    if (!(await esperar(w, CLICAR('/^gest[aã]o de guias$/i')))) return { ok: false, passo: 'card Gestão de Guias' };
    if (!(await esperar(w, CLICAR('/^emiss[aã]o de guia r[aá]pida$/i')))) return { ok: false, passo: 'card Emissão de Guia Rápida' };
    if (!(await esperar(w, texto('/Compet[eê]ncia de Apura[cç][aã]o/i')))) return { ok: false, passo: 'tela de pesquisa' };
  }
  // competência: o campo é um select com busca; digita e escolhe a opção
  if (!(await escolherCompetencia(w, '/^Compet[eê]ncia de Apura[cç][aã]o$/i', comp)))
    return { ok: false, passo: `competência ${comp} não encontrada na lista (pode estar sem débito em aberto)` };
  if (!(await esperar(w, CLICAR('/^pesquisar$/i'), 8000))) return { ok: false, passo: 'botão Pesquisar' };
  const res = await esperar(w, `const t = document.body.innerText || ''; if (/Vencimento da Guia/i.test(t)) return 'ok'; if (/nenhum (d[eé]bito|registro|resultado)|n[aã]o (foram|h[aá]) (encontrad|d[eé]bito)/i.test(t)) return 'vazio'; return false;`, 30000);
  if (res === 'vazio') return { erro: `O FGTS Digital não tem débito em aberto na competência ${comp} para este cliente.` };
  if (!res) return { ok: false, passo: 'resultado da pesquisa' };
  // seção "Mensal - Vencimento da Guia"
  const secao = `(() => { const h = [...document.querySelectorAll('h1, h2, h3, h4, h5, div, span')].filter((x) => /^Mensal\\s*-\\s*Vencimento da Guia/i.test((x.textContent || '').trim()) && (x.textContent || '').length < 60)[0];
    let s = h; for (let i = 0; s && i < 6; i++) { if (s.querySelectorAll('button').length >= 2) return s; s = s.parentElement; } return document; })()`;
  if (tipo === 'RECIBO') {
    if (!(await js(w, PDF_DA_SECAO).catch(() => false))) return { ok: false, passo: 'ícone PDF do recibo' };
    return { ok: true };
  }
  if (!(await js(w, `const s = ${secao}; const b = [...s.querySelectorAll('button')].find((x) => /emitir guia/i.test(x.textContent || '')); if (!b) return false; b.click(); return true;`).catch(() => false)))
    return { ok: false, passo: 'botão Emitir guia' };
  // emissão com outra data de pagamento (recálculo): se o portal abrir a caixa com a data, preenche e confirma
  await dormir(1500);
  const modal = `document.querySelector('[role=dialog], .br-modal, .modal.show, .p-dialog, .mat-dialog-container')`;
  if (await js(w, `return !!${modal};`).catch(() => false)) {
    if (dataPagamento) {
      const br = dataPagamento.split('-').reverse().join('/');
      await js(w, `const m = ${modal}; const inp = [...m.querySelectorAll('input')].find((x) => x.type === 'date' || /data|dd\\/mm/i.test((x.placeholder || '') + (x.name || '') + (x.id || '')));
        if (!inp) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inp, inp.type === 'date' ? ${JSON.stringify(dataPagamento)} : ${JSON.stringify(br)}); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); inp.dispatchEvent(new Event('blur', { bubbles: true })); return true;`).catch(() => false);
      await dormir(800);
    }
    if (!(await esperar(w, CLICAR('/^(emitir( guia)?|gerar( guia)?|confirmar|ok)$/i', modal), 8000))) return { ok: false, passo: 'confirmação da emissão' };
  }
  return { ok: true };
}

/** Escreve num campo (com máscara) como se fosse digitado: seleciona tudo e insere o texto. */
async function digitar(w, seletorJs, valor) {
  const ok = await js(w, `const inp = ${seletorJs}; if (!inp) return false; inp.scrollIntoView({ block: 'center' }); inp.focus(); inp.select?.(); return true;`).catch(() => false);
  if (!ok) return false;
  if (w.webContents.insertText) { await w.webContents.insertText(valor); }
  await js(w, `const inp = document.activeElement; if (!inp || inp.tagName !== 'INPUT') return false;
    if (inp.value !== ${JSON.stringify(valor)}) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, ${JSON.stringify(valor)}); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    inp.dispatchEvent(new Event('change', { bubbles: true })); inp.blur(); return true;`).catch(() => false);
  return true;
}
/** Campo de competência (select com busca) logo abaixo do rótulo; escolhe a opção MM/AAAA. */
async function escolherCompetencia(w, rotulo, comp) {
  const achar = `(() => { const lab = [...document.querySelectorAll('label, span, div, p')].filter((x) => ${rotulo}.test((x.textContent || '').trim()) && (x.textContent || '').trim().length < 40)
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]; let s = lab; for (let i = 0; s && i < 4; i++) { const inp = s.querySelector('input'); if (inp) return inp; s = s.parentElement; } return null; })()`;
  if ((await js(w, `return ${achar}?.value?.trim() ?? '';`).catch(() => '')) === comp) return true;
  if (!(await digitar(w, achar, comp))) return false;
  const esc = comp.replace('/', '\\/');
  await esperar(w, CLICAR(`/^${esc}$/`, `document.querySelector('[role=listbox], .br-list, .dropdown-menu, .p-dropdown-panel, .options') ?? document`), 6000);
  await dormir(400);
  return (await js(w, `return ${achar}?.value?.trim() ?? '';`).catch(() => '')) === comp;
}

/**
 * Recálculo (guia em atraso): Gestão de Guias > Emissão de Guia Parametrizada > competência inicial e final >
 * Pesquisar > marca os débitos da competência > Adicionar à guia > Avançar > Avançar (consignado) > Definir
 * Vencimento (data de pagamento) > Avançar > Emitir Guia.
 */
async function recalcularNaParametrizada(w, competencia, dataPagamento, aoAvisar) {
  if (!competencia) return { ok: false, passo: 'competência não informada' };
  const [aaaa, mm] = competencia.split('-'), comp = `${mm}/${aaaa}`;
  aoAvisar?.({ etapa: 'documento', mensagem: `Abrindo a Emissão de Guia Parametrizada (${comp})…` });
  if (!(await js(w, texto('/Emiss[aã]o de Guia Parametrizada[\\s\\S]*Inicial/i')).catch(() => false))) {
    if (!(await js(w, texto('/EMISS[AÃ]O DE GUIA PARAMETRIZADA/i')).catch(() => false)))
      if (!(await esperar(w, CLICAR('/^gest[aã]o de guias$/i')))) return { ok: false, passo: 'card Gestão de Guias' };
    if (!(await esperar(w, CLICAR('/^emiss[aã]o de guia parametrizada$/i')))) return { ok: false, passo: 'card Emissão de Guia Parametrizada' };
    if (!(await esperar(w, texto('/Inicial[\\s\\S]*Final/')))) return { ok: false, passo: 'tela de pesquisa' };
  }
  // limita a pesquisa à competência (se o campo não aceitar, pesquisa o período padrão e marca só as linhas dela)
  await escolherCompetencia(w, '/^Inicial$/i', comp);
  await escolherCompetencia(w, '/^Final$/i', comp);
  if (!(await esperar(w, CLICAR('/^pesquisar$/i'), 8000))) return { ok: false, passo: 'botão Pesquisar' };
  const linhas = `[...document.querySelectorAll('tbody tr')].filter((tr) => [...tr.cells].some((td) => (td.textContent || '').trim() === ${JSON.stringify(comp)}))`;
  const res = await esperar(w, `if (${linhas}.length) return 'ok'; const t = document.body.innerText || ''; if (/nenhum (d[eé]bito|registro|resultado)|n[aã]o (foram|h[aá]) (encontrad|d[eé]bito)/i.test(t)) return 'vazio'; return false;`, 30000);
  if (res === 'vazio' || !res) return res === 'vazio' ? { erro: `O FGTS Digital não tem débito da competência ${comp} para recalcular.` } : { ok: false, passo: `débitos de ${comp} na lista` };
  const marcadas = await js(w, `let n = 0; for (const tr of ${linhas}) {
      const inp = tr.querySelector('input[type=checkbox]'); if (inp?.checked) { n++; continue; }
      const alvo = tr.querySelector('label') ?? tr.querySelector('[role=checkbox], .p-checkbox-box, .br-checkbox') ?? inp; if (alvo) { alvo.click(); n++; } }
    return n;`).catch(() => 0);
  if (!marcadas) return { ok: false, passo: 'marcar os débitos' };
  await dormir(600);
  if (!(await esperar(w, CLICAR('/^adicionar [aà] guia$/i'), 8000))) return { ok: false, passo: 'Adicionar à guia' };
  if (!(await esperar(w, texto('/Resumo dos d[eé]bitos adicionados/i'), 15000))) return { ok: false, passo: 'resumo dos débitos' };
  // Avançar até "Definir Vencimento" (passa pela tela de consignado)
  for (let i = 0; i < 3 && !(await js(w, texto('/Definir Vencimento/i')).catch(() => false)); i++) {
    if (!(await esperar(w, CLICAR('/^avan[cç]ar$/i'), 8000))) return { ok: false, passo: 'Avançar' };
    await esperar(w, texto('/Definir Vencimento|Selecionar D[eé]bitos Consignado/i'), 15000);
    await dormir(800);
  }
  if (!(await js(w, texto('/Definir Vencimento/i')).catch(() => false))) return { ok: false, passo: 'tela Definir Vencimento' };
  if (dataPagamento) {
    const br = dataPagamento.split('-').reverse().join('/');
    const campo = `(() => { const lab = [...document.querySelectorAll('label, span, div, th')].filter((x) => /^Vencimento da/i.test((x.textContent || '').trim()) && (x.textContent || '').length < 40)[0];
      let s = lab; for (let i = 0; s && i < 4; i++) { const inp = s.querySelector('input'); if (inp) return inp; s = s.parentElement; } return null; })()`;
    if (!(await digitar(w, campo, br))) return { ok: false, passo: 'campo Vencimento da guia' };
    await dormir(1500); // o portal recalcula multa e juros para a nova data
  }
  if (!(await esperar(w, CLICAR('/^avan[cç]ar$/i'), 8000))) return { ok: false, passo: 'Avançar (vencimento)' };
  if (!(await esperar(w, CLICAR('/^emitir guia$/i'), 20000))) return { ok: false, passo: 'botão Emitir Guia' };
  return { ok: true };
}

export async function documentoFgts(pai, cliente, tipo, aoAvisar) {
  const w = await esperarLogin(pai, aoAvisar);
  if (!(await logado())) throw new Error('A sessão do FGTS Digital expirou. Entre de novo.');
  const p = await definirProcurador(w, cliente.documento, cliente.nome, aoAvisar);
  if (!p.ok) return { ok: false, erro: p.erro ?? p.motivo ?? 'Não foi possível entrar no perfil do cliente.' };
  const ses = session.fromPartition(PARTICAO);
  const pasta = fs.mkdtempSync(path.join(app.getPath('temp'), 'kontor-fgts-'));
  let pronto = null, falhou = null;
  const aoBaixar = (_e, item) => {
    const nome = item.getFilename() || `${tipo === 'RECIBO' ? 'Recibo_FGTS' : 'Guia_FGTS'}.pdf`;
    const destino = path.join(pasta, nome.replace(/[^\w.\- ]+/g, '_'));
    item.setSavePath(destino);
    item.once('done', (_ev, estado) => {
      if (estado !== 'completed') { falhou = 'O download foi interrompido.'; return; }
      try {
        const buf = fs.readFileSync(destino);
        if (buf.subarray(0, 4).toString() !== '%PDF') return; // não é o PDF (ex.: planilha); continua esperando
        pronto = { nome: nome.toLowerCase().endsWith('.pdf') ? nome : `${nome}.pdf`, base64: buf.toString('base64') };
      } catch (err) { falhou = String(err?.message ?? err); }
    });
  };
  ses.on('will-download', aoBaixar);
  // PDF aberto em outra janela (blob ou link) vira download
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^blob:|\.pdf(\?|$)|\/pdf|guia|recibo|comprovante/i.test(url)) w.webContents.downloadURL(url);
    return { action: 'deny' };
  });
  try {
    // Emissão de Guia Rápida: Gestão de Guias > Emissão de Guia Rápida > competência > Pesquisar > "Emitir guia"
    // (guia) ou o ícone PDF ao lado de "FGTS" (recibo). Se algum passo não for achado, o usuário termina na mão.
    const auto = await (tipo === 'RECALCULO' ? recalcularNaParametrizada(w, cliente.competencia, cliente.dataPagamento, aoAvisar) : emitirNaGuiaRapida(w, cliente.competencia, tipo, cliente.dataPagamento, aoAvisar))
      .catch((e) => ({ ok: false, passo: String(e?.message ?? e) }));
    if (auto.erro) return { ok: false, erro: auto.erro };
    aoAvisar?.({ etapa: 'documento', mensagem: auto.ok
      ? `${tipo === 'RECIBO' ? 'Recibo pedido' : 'Guia pedida'} ao FGTS Digital. Aguardando o PDF…`
      : `Não consegui fazer sozinho (${auto.passo}). Termine na janela do FGTS Digital: ${tipo === 'RECALCULO' ? 'na Emissão de Guia Parametrizada, marque os débitos da competência, Adicionar à guia, Avançar, defina o vencimento e clique em Emitir Guia' : tipo === 'GUIA' ? 'na Emissão de Guia Rápida, pesquise a competência e clique em Emitir guia' : 'na Emissão de Guia Rápida, pesquise a competência e clique no ícone PDF ao lado de FGTS'}. O Kontor guarda o PDF sozinho.` });
    w.show(); w.focus();
    const fim = Date.now() + 15 * 60e3;
    while (Date.now() < fim) {
      if (pronto) return { ok: true, ...pronto };
      if (falhou) return { ok: false, erro: falhou };
      if (!janelaFgts || janelaFgts.isDestroyed()) return { ok: false, erro: 'A janela do FGTS Digital foi fechada antes de baixar o PDF.' };
      await dormir(700);
    }
    return { ok: false, erro: 'Nenhum PDF foi baixado em 15 minutos.' };
  } finally {
    ses.removeListener('will-download', aoBaixar);
    if (janelaFgts && !janelaFgts.isDestroyed()) janelaFgts.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
  }
}
