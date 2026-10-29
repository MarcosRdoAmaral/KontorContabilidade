// Consulta ao FGTS Digital (portal do empregador) pelo aplicativo instalado.
// Não há API pública: o usuário entra no portal numa janela do Kontor, com o certificado digital do escritório
// (gov.br), e o Kontor usa as mesmas telas do portal para, cliente a cliente, definir o perfil "Procurador" e ler as
// competências em aberto (Emissão de Guia Rápida). Nada é emitido nem alterado no portal.
import { app, BrowserWindow, dialog, session } from 'electron';

const ORIGEM = 'https://fgtsdigital.sistema.gov.br';
const PARTICAO = 'persist:fgts-digital';
let janelaFgts = null;
let certificadoEscolhido = null; // fingerprint escolhido nesta abertura do programa

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Certificado do login gov.br: sem isto o Electron usaria o primeiro certificado instalado, sem perguntar.
app.on('select-client-certificate', async (event, webContents, url, lista, callback) => {
  if (!janelaFgts || janelaFgts.isDestroyed() || webContents !== janelaFgts.webContents) return;
  event.preventDefault();
  const salvo = lista.find((c) => c.fingerprint === certificadoEscolhido);
  if (salvo) return callback(salvo);
  if (!lista.length) return callback();
  const nomes = lista.map((c) => `${c.subjectName}${c.validExpiry ? ` (válido até ${new Date(c.validExpiry * 1000).toLocaleDateString('pt-BR')})` : ''}`);
  const r = await dialog.showMessageBox(janelaFgts, {
    type: 'question', title: 'Certificado digital', message: 'Escolha o certificado para entrar no FGTS Digital',
    detail: 'Use o certificado do escritório (e-CNPJ): o Kontor consulta os clientes como procurador.', buttons: [...nomes, 'Cancelar'], cancelId: nomes.length, noLink: true,
  });
  if (r.response >= lista.length) return callback();
  certificadoEscolhido = lista[r.response].fingerprint;
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
  aoAvisar?.({ etapa: 'login', mensagem: 'Entre no FGTS Digital com o certificado do escritório na janela que abriu.' });
  const fim = Date.now() + 10 * 60e3;
  while (Date.now() < fim) {
    if (!janelaFgts || janelaFgts.isDestroyed()) throw new Error('A janela do FGTS Digital foi fechada.');
    if (await logado()) return w;
    await dormir(1500);
  }
  throw new Error('O login no FGTS Digital não foi concluído em 10 minutos.');
}

/** Define o perfil "Procurador" para o CNPJ/CPF do cliente, pelas telas do portal. */
async function definirProcurador(w, ni) {
  await w.loadURL(`${ORIGEM}/portal/escolhaPerfil`);
  // o diálogo "Definir Perfil" abre sozinho ao escolher perfil; se não abrir, usa o botão "Trocar Perfil"
  const pronto = await js(w, `
    const achar = () => document.querySelector('input[placeholder="Informe CNPJ ou CPF"]');
    for (let i = 0; i < 40 && !achar(); i++) {
      if (i === 6) [...document.querySelectorAll('button')].find((b) => /trocar perfil/i.test(b.textContent))?.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    return !!achar();`);
  if (!pronto) throw new Error('A tela de escolha de perfil do FGTS Digital não abriu.');
  // perfil Procurador (ng-select): abre a lista e escolhe a opção, se ainda não estiver escolhida
  await js(w, `
    const dlg = document.querySelector('[role=dialog]') ?? document;
    const valor = () => (dlg.querySelector('.ng-value-label, .ng-value')?.textContent ?? '').trim();
    if (!/procurador/i.test(valor())) {
      const cb = dlg.querySelector('[role=combobox]') ?? dlg.querySelector('ng-select input');
      cb?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); cb?.click();
      for (let i = 0; i < 20; i++) {
        const op = [...document.querySelectorAll('.ng-option, [role=option]')].find((o) => /^\\s*procurador\\s*$/i.test(o.textContent));
        if (op) { op.click(); break; }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const ni = dlg.querySelector('input[placeholder="Informe CNPJ ou CPF"]');
    for (let i = 0; i < 20 && ni.disabled; i++) await new Promise((r) => setTimeout(r, 150));
    ni.focus(); ni.select?.();
    return true;`);
  // digita como teclado (a máscara do campo só aceita digitação)
  await js(w, `const ni = document.querySelector('input[placeholder="Informe CNPJ ou CPF"]'); ni.value = ''; ni.dispatchEvent(new Event('input', { bubbles: true })); ni.focus(); return true;`);
  await w.webContents.insertText(ni);
  await dormir(400);
  const r = await js(w, `
    const dlg = document.querySelector('[role=dialog]') ?? document;
    [...dlg.querySelectorAll('button')].find((b) => /^\\s*(definir|selecionar)\\s*$/i.test(b.textContent))?.click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const erro = document.querySelector('[role=alert]')?.textContent?.replace(/\\s+/g, ' ').replace(/^\\s*Mensagem de Erro\\s*/i, '').replace(/Fechar\\s*$/i, '').trim();
      if (erro) return { ok: false, erro };
      const c = Object.fromEntries(document.cookie.split(';').map((x) => x.trim().split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
      if (c.fgtsd_tipo_perfil === '2' && c.fgtsd_ni_perfil === ${JSON.stringify(ni)}) return { ok: true };
      // reserva: a tela inicial já mostra o empregador representado
      const emp = (document.body.innerText.match(/Empregador:\s*([\d./-]+)/) ?? [])[1]?.replace(/\D/g, '');
      if (emp === ${JSON.stringify(ni)} && !document.querySelector('[role=dialog]')) return { ok: true };
    }
    return { ok: false, erro: 'O portal não confirmou a troca de perfil.' };`);
  return r;
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
      const p = await definirProcurador(w, c.documento);
      if (!p.ok) { resultados.push({ empresa_id: c.id, situacao: /procura/i.test(p.erro) ? 'SEM_PROCURACAO' : 'ERRO', mensagem: p.erro }); continue; }
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
