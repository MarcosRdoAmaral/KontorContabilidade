import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { salvarAcesso } from './acessos.js';

/**
 * Importa da planilha "Controle de Entregas" o que é fixo de cada cliente: código de acesso do Simples Nacional
 * (com CPF do responsável e atividade), senha previdenciária, canal de envio (WhatsApp/e-mail) e número de registro
 * do departamento pessoal. Senhas são ligadas pelo CNPJ; canal e registro, pelo nome do cliente.
 */

const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const txt = (v: any): string => (v === undefined || v === null ? '' : typeof v === 'object' ? (v['#text'] !== undefined ? String(v['#text']) : '') : String(v));
const colunaIndice = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Todas as abas do .xlsx como linhas de texto (fórmulas: o último valor calculado). */
export function lerAbas(buf: Buffer): Record<string, string[][]> {
  let z: Record<string, Uint8Array>;
  try { z = unzipSync(new Uint8Array(buf)); } catch { throw new ErroNegocio('Não foi possível abrir a planilha. Envie o arquivo .xlsx.'); }
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => ['row', 'c', 'si', 'r', 'sheet', 'Relationship'].includes(n), parseTagValue: false, trimValues: false });
  const ler = (nome: string) => (z[nome] ? xml.parse(strFromU8(z[nome])) : null);
  const compart: string[] = arr(ler('xl/sharedStrings.xml')?.sst?.si).map((si: any) => (si.t !== undefined ? txt(si.t) : arr(si.r).map((r: any) => txt(r.t)).join('')));
  const rels = new Map(arr(ler('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship).map((r: any) => [r['@_Id'], r['@_Target']]));
  const abas: Record<string, string[][]> = {};
  for (const sh of arr(ler('xl/workbook.xml')?.workbook?.sheets?.sheet) as any[]) {
    const alvo = rels.get(sh['@_r:id']) as string | undefined;
    if (!alvo) continue;
    const folha = ler(alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`);
    abas[String(sh['@_name'])] = arr(folha?.worksheet?.sheetData?.row).map((row: any) => {
      const linha: string[] = [];
      for (const c of arr(row.c) as any[]) {
        const t = c['@_t'];
        let v = t === 's' ? compart[Number(txt(c.v))] ?? '' : t === 'inlineStr' ? (c.is?.t !== undefined ? txt(c.is.t) : '') : txt(c.v);
        if ((t === undefined || t === 'n') && /e/i.test(v) && Number.isFinite(Number(v))) v = BigInt(Math.round(Number(v))).toString();
        linha[colunaIndice(c['@_r'] ?? 'A1')] = v.trim();
      }
      return Array.from(linha, (x) => x ?? '');
    });
  }
  return abas;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(ltda|me|epp|eireli|s a|sa|sociedade|unipessoal|limitada|comercio|servicos|de|da|do|dos|das|e)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Liga um nome da planilha a um cliente da carteira (exato, um contém o outro, ou palavras em comum). */
function porNome(clientes: { id: number; nomes: string[] }[], nome: string): number | null {
  const n = norm(nome);
  if (n.length < 3) return null;
  const exato = clientes.filter((c) => c.nomes.includes(n));
  if (exato.length === 1) return exato[0].id;
  const contem = clientes.filter((c) => c.nomes.some((x) => x.length >= 4 && n.length >= 4 && (x.startsWith(n) || n.startsWith(x))));
  if (contem.length === 1) return contem[0].id;
  const pal = new Set(n.split(' '));
  let melhor: { id: number; nota: number } | null = null, empate = false;
  for (const c of clientes) for (const x of c.nomes) {
    const px = new Set(x.split(' '));
    const comum = [...pal].filter((p) => px.has(p) && p.length > 2).length;
    const nota = comum / Math.max(pal.size, px.size);
    if (nota >= 0.6) { if (!melhor || nota > melhor.nota) { melhor = { id: c.id, nota }; empate = false; } else if (nota === melhor.nota && melhor.id !== c.id) empate = true; }
  }
  return melhor && !empate ? melhor.id : null;
}

const cabecalho = (linhas: string[][], ...nomes: RegExp[]) => {
  const i = linhas.findIndex((l) => nomes.every((r) => l.some((c) => r.test(c))));
  return i < 0 ? null : { i, col: (r: RegExp) => linhas[i].findIndex((c) => r.test(c)) };
};
const aba = (abas: Record<string, string[][]>, r: RegExp) => Object.entries(abas).find(([n]) => r.test(n))?.[1] ?? null;

export interface ItemImportacao { tipo: 'SIMPLES' | 'PREVIDENCIA' | 'CANAL' | 'REGISTRO'; linha: number; nome: string; documento?: string | null; empresa_id: number | null; cliente: string | null; valor?: string | null }

function interpretar(escritorioId: number, buf: Buffer) {
  const abas = lerAbas(buf);
  const emp = db.prepare("SELECT id, documento, razao_social, nome_fantasia FROM empresas WHERE escritorio_id = ? AND (na_carteira = 1 OR eh_escritorio = 1)").all(escritorioId) as any[];
  const porDoc = new Map(emp.map((e) => [e.documento, e]));
  const nomeDe = new Map(emp.map((e) => [e.id, e.nome_fantasia || e.razao_social]));
  const clientes = emp.map((e) => ({ id: e.id, nomes: [norm(e.razao_social ?? ''), norm(e.nome_fantasia ?? '')].filter(Boolean) }));
  const doc = (s: string) => { const d = s.replace(/\D/g, ''); return d.length > 11 ? d.padStart(14, '0') : d.length ? d.padStart(11, '0') : ''; };
  const itens: (ItemImportacao & { segredo?: Record<string, string | null> })[] = [];

  const sn = aba(abas, /simples/i);
  const hs = sn && cabecalho(sn, /^cnpj$/i, /c[óo]digo/i);
  if (sn && hs) {
    const [cN, cD, cCpf, cCod, cAt] = [hs.col(/empresa/i), hs.col(/^cnpj$/i), hs.col(/cpf/i), hs.col(/c[óo]digo/i), hs.col(/atividade/i)];
    sn.slice(hs.i + 1).forEach((l, k) => {
      const d = doc(l[cD] ?? ''); if (!d || !l[cCod]) return;
      const e = porDoc.get(d);
      itens.push({ tipo: 'SIMPLES', linha: hs.i + k + 2, nome: l[cN] ?? '', documento: d, empresa_id: e?.id ?? null, cliente: e ? nomeDe.get(e.id) ?? null : null, valor: l[cAt] || null,
        segredo: { sn_codigo: l[cCod] || null, sn_cpf_responsavel: cCpf >= 0 ? l[cCpf] || null : null, sn_atividade: cAt >= 0 ? l[cAt] || null : null } });
    });
  }
  const pv = aba(abas, /previd/i);
  const hp = pv && cabecalho(pv, /^cnpj$/i, /senha/i);
  if (pv && hp) {
    const [cN, cD, cS] = [hp.col(/raz[ãa]o|empresa/i), hp.col(/^cnpj$/i), hp.col(/senha/i)];
    pv.slice(hp.i + 1).forEach((l, k) => {
      const d = doc(l[cD] ?? ''); if (!d || !l[cS]) return;
      const e = porDoc.get(d);
      itens.push({ tipo: 'PREVIDENCIA', linha: hp.i + k + 2, nome: l[cN] ?? '', documento: d, empresa_id: e?.id ?? null, cliente: e ? nomeDe.get(e.id) ?? null : null, segredo: { prev_senha: l[cS] } });
    });
  }
  const fi = aba(abas, /^fiscal/i);
  const hf = fi && cabecalho(fi, /^empresas?$/i);
  if (fi && hf) {
    const cN = hf.col(/^empresas?$/i);
    fi.slice(hf.i + 1).forEach((l, k) => {
      const canal = l.find((c) => /^(whats\s*app|e-?mail)$/i.test(c));
      if (!l[cN] || !canal) return;
      const id = porNome(clientes, l[cN]);
      itens.push({ tipo: 'CANAL', linha: hf.i + k + 2, nome: l[cN], empresa_id: id, cliente: id ? nomeDe.get(id) ?? null : null, valor: /whats/i.test(canal) ? 'WHATSAPP' : 'EMAIL' });
    });
  }
  const rh = aba(abas, /^(rh|dp|pessoal|departamento)/i);
  const hr = rh && cabecalho(rh, /registro/i, /^empresas?$/i);
  if (rh && hr) {
    const [cR, cN] = [hr.col(/registro/i), hr.col(/^empresas?$/i)];
    rh.slice(hr.i + 1).forEach((l, k) => {
      if (!l[cN] || !/^\d+$/.test(l[cR] ?? '')) return;
      const id = porNome(clientes, l[cN]);
      itens.push({ tipo: 'REGISTRO', linha: hr.i + k + 2, nome: l[cN], empresa_id: id, cliente: id ? nomeDe.get(id) ?? null : null, valor: l[cR] });
    });
  }
  if (!itens.length) throw new ErroNegocio('Não encontrei na planilha as abas de senhas (Simples Nacional, Previdenciária), Fiscal ou RH no formato esperado.');
  return itens;
}

/** Prévia: o que será importado e a qual cliente (sem mostrar senhas). */
export function analisarControle(escritorioId: number, buf: Buffer) {
  const itens = interpretar(escritorioId, buf).map(({ segredo, ...i }) => i);
  const conta = (t: string) => ({ total: itens.filter((i) => i.tipo === t).length, ligados: itens.filter((i) => i.tipo === t && i.empresa_id).length });
  return { itens, resumo: { SIMPLES: conta('SIMPLES'), PREVIDENCIA: conta('PREVIDENCIA'), CANAL: conta('CANAL'), REGISTRO: conta('REGISTRO') } };
}

/** Grava os itens escolhidos (tipo:linha), só dos que foram ligados a um cliente. */
export function importarControle(escritorioId: number, usuarioId: number, buf: Buffer, escolhidos: string[], podeSenhas: boolean) {
  const sel = new Set(escolhidos);
  const itens = interpretar(escritorioId, buf).filter((i) => i.empresa_id && sel.has(`${i.tipo}:${i.linha}`));
  let n = 0;
  db.transaction(() => {
    for (const i of itens) {
      if (i.tipo === 'CANAL') db.prepare('UPDATE empresas SET canal_envio = ? WHERE id = ?').run(i.valor, i.empresa_id);
      else if (i.tipo === 'REGISTRO') db.prepare('UPDATE empresas SET registro_dp = ? WHERE id = ?').run(i.valor, i.empresa_id);
      else {
        if (!podeSenhas) continue;
        const a = db.prepare('SELECT * FROM acessos_cliente WHERE empresa_id = ?').get(i.empresa_id) as any;
        const s = i.segredo ?? {};
        salvarAcesso(escritorioId, usuarioId, i.empresa_id!, {
          sn_cpf_responsavel: i.tipo === 'SIMPLES' ? (s.sn_cpf_responsavel?.replace(/\D/g, '') || null) : a?.sn_cpf_responsavel ?? null,
          sn_codigo: i.tipo === 'SIMPLES' ? s.sn_codigo : undefined,
          sn_atividade: i.tipo === 'SIMPLES' ? s.sn_atividade ?? null : a?.sn_atividade ?? null,
          prev_senha: i.tipo === 'PREVIDENCIA' ? s.prev_senha : undefined,
          observacoes: a?.observacoes ?? null,
        });
      }
      n++;
    }
  })();
  return { importados: n };
}
