import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { consultarCnpj } from './consulta-cnpj.js';
import { cnpjValido, cpfValido } from '../nfse/validacao.js';
import { ClienteCarteira, criarCliente } from './carteira.js';

// ---------------------------------------------------------------------------
// Leitura da planilha (xlsx lido direto do zip; csv/txt também)
// ---------------------------------------------------------------------------
type Celula = { texto: string; numero: boolean };

const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const txt = (v: any): string => (v === undefined || v === null ? '' : typeof v === 'object' ? (v['#text'] !== undefined ? String(v['#text']) : '') : String(v));
const colunaIndice = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function lerXlsx(buf: Buffer): Celula[][] {
  let z: Record<string, Uint8Array>;
  try { z = unzipSync(new Uint8Array(buf)); } catch { throw new ErroNegocio('Não foi possível abrir a planilha. Envie um arquivo .xlsx ou .csv.'); }
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => ['row', 'c', 'si', 'r', 'sheet', 'Relationship'].includes(n), parseTagValue: false, trimValues: false });
  const ler = (nome: string) => (z[nome] ? xml.parse(strFromU8(z[nome])) : null);
  const compart: string[] = (arr(ler('xl/sharedStrings.xml')?.sst?.si)).map((si: any) => (si.t !== undefined ? txt(si.t) : arr(si.r).map((r: any) => txt(r.t)).join('')));
  // primeira planilha, conforme o workbook
  const wb = ler('xl/workbook.xml'), rels = ler('xl/_rels/workbook.xml.rels');
  const rid = arr(wb?.workbook?.sheets?.sheet)[0]?.['@_r:id'];
  const alvo = arr(rels?.Relationships?.Relationship).find((r: any) => r['@_Id'] === rid)?.['@_Target'];
  const caminho = alvo ? (alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`) : Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  const folha = caminho ? ler(caminho) : null;
  if (!folha) throw new ErroNegocio('A planilha está vazia ou em formato não reconhecido.');
  return arr(folha.worksheet?.sheetData?.row).map((row: any) => {
    const linha: Celula[] = [];
    for (const c of arr(row.c)) {
      const t = c['@_t'];
      let texto = '', numero = false;
      if (t === 's') texto = compart[Number(txt(c.v))] ?? '';
      else if (t === 'inlineStr') texto = c.is?.t !== undefined ? txt(c.is.t) : arr(c.is?.r).map((r: any) => txt(r.t)).join('');
      else { texto = txt(c.v); numero = t === undefined || t === 'n'; }
      if (numero && /e/i.test(texto) && Number.isFinite(Number(texto))) texto = BigInt(Math.round(Number(texto))).toString();
      linha[colunaIndice(c['@_r'] ?? 'A1')] = { texto: texto.trim(), numero };
    }
    return Array.from(linha, (c) => c ?? { texto: '', numero: false });
  });
}

function lerCsv(buf: Buffer): Celula[][] {
  let s = buf.toString('utf8');
  if (s.includes('�')) s = buf.toString('latin1');
  s = s.replace(/^﻿/, '');
  const linhas = s.split(/\r?\n/).filter((l) => l.trim());
  const sep = (linhas[0]?.split(';').length ?? 0) >= (linhas[0]?.split(',').length ?? 0) ? ';' : ',';
  return linhas.map((l) => l.split(sep).map((c) => ({ texto: c.trim().replace(/^"|"$/g, ''), numero: false })));
}

/** Reconhece CNPJ ou CPF numa célula; o Excel costuma perder os zeros à esquerda de números. */
function documentoDe(c: Celula): { doc: string | null; invalido: boolean } {
  if (!/^[\d.\-/\s]+$/.test(c.texto)) return { doc: null, invalido: false };
  const d = c.texto.replace(/\D/g, '');
  if (d.length < 8 || d.length > 14) return { doc: null, invalido: false };
  if (d.length === 14 && cnpjValido(d)) return { doc: d, invalido: false };
  if (d.length === 11 && cpfValido(d)) return { doc: d, invalido: false };
  if (c.numero || d.length < 11) {
    if (d.length <= 11 && cpfValido(d.padStart(11, '0'))) return { doc: d.padStart(11, '0'), invalido: false };
    if (cnpjValido(d.padStart(14, '0'))) return { doc: d.padStart(14, '0'), invalido: false };
  }
  return { doc: null, invalido: d.length >= 11 };
}

export interface LinhaPlanilha { linha: number; documento: string | null; tipo: 'CNPJ' | 'CPF' | null; nome: string | null; situacao: 'NOVO' | 'EXISTE' | 'REPETIDO' | 'INVALIDO'; motivo?: string }

export function analisarPlanilha(empresaId: number, arquivo: string, buf: Buffer) {
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroNegocio('Empresa não encontrada.', 404);
  return analisar(arquivo, buf, new Set((db.prepare("SELECT documento FROM tomadores WHERE empresa_id = ? AND documento IS NOT NULL").all(empresaId) as { documento: string }[]).map((x) => x.documento)));
}

/** Planilha para a Carteira: "já cadastrado" é quem já está na carteira ou é empresa do sistema. */
export function analisarPlanilhaCarteira(escritorioId: number, arquivo: string, buf: Buffer) {
  return analisar(arquivo, buf, new Set((db.prepare('SELECT documento FROM empresas WHERE escritorio_id = ?').all(escritorioId) as { documento: string }[]).map((x) => x.documento)));
}

function analisar(arquivo: string, buf: Buffer, existentes: Set<string>) {
  const celulas = buf.subarray(0, 2).toString() === 'PK' ? lerXlsx(buf) : /\.xlsx?$/i.test(arquivo) && buf.subarray(0, 4).toString('hex') === 'd0cf11e0'
    ? (() => { throw new ErroNegocio('Arquivo .xls antigo: salve a planilha como .xlsx (ou .csv) e envie de novo.'); })() : lerCsv(buf);
  const vistos = new Set<string>();
  const linhas: LinhaPlanilha[] = [];
  celulas.forEach((row, i) => {
    let doc: string | null = null, invalido = false;
    for (const c of row) { const r = documentoDe(c); if (r.doc) { doc = r.doc; break; } if (r.invalido) invalido = true; }
    if (!doc) { if (invalido) linhas.push({ linha: i + 1, documento: null, tipo: null, nome: null, situacao: 'INVALIDO', motivo: 'CNPJ/CPF inválido (confira os dígitos)' }); return; }
    const nome = row.map((c) => c.texto).filter((t) => t && /[A-Za-zÀ-ÿ]{2}/.test(t) && !documentoDe({ texto: t, numero: false }).doc).sort((a, b) => b.length - a.length)[0] ?? null;
    const base = { linha: i + 1, documento: doc, tipo: (doc.length === 14 ? 'CNPJ' : 'CPF') as 'CNPJ' | 'CPF', nome };
    if (existentes.has(doc)) linhas.push({ ...base, situacao: 'EXISTE', motivo: 'Já cadastrado' });
    else if (vistos.has(doc)) linhas.push({ ...base, situacao: 'REPETIDO', motivo: 'Repetido na planilha' });
    else { vistos.add(doc); linhas.push({ ...base, situacao: base.tipo === 'CPF' && !nome ? 'INVALIDO' : 'NOVO', motivo: base.tipo === 'CPF' && !nome ? 'CPF precisa do nome na planilha' : undefined }); }
  });
  const conta = (s: string) => linhas.filter((l) => l.situacao === s).length;
  return { linhas, resumo: { novos: conta('NOVO'), existentes: conta('EXISTE'), repetidos: conta('REPETIDO'), invalidos: conta('INVALIDO') } };
}

// ---------------------------------------------------------------------------
// Importação: consulta o CNPJ, cria o cadastro e deixa marcado "falta conferir"
// ---------------------------------------------------------------------------
export interface ResultadoItem { documento: string; ok: boolean; id?: number; nome?: string; mensagem: string }

export async function importarLote(empresaId: number, itens: { documento: string; nome?: string | null }[]): Promise<ResultadoItem[]> {
  const res: ResultadoItem[] = [];
  for (const it of itens) {
    const doc = it.documento.replace(/\D/g, '');
    try {
      if (db.prepare('SELECT 1 FROM tomadores WHERE empresa_id = ? AND documento = ?').get(empresaId, doc)) { res.push({ documento: doc, ok: false, mensagem: 'Já cadastrado.' }); continue; }
      const motivos: string[] = [];
      let d: any = { nome: (it.nome ?? '').trim() || null };
      if (doc.length === 14) {
        if (!cnpjValido(doc)) throw new ErroNegocio('CNPJ inválido.');
        try {
          const r = await consultarCnpj(doc);
          d = { nome: r.razao_social || d.nome, email: r.email, fone: r.fone, cep: r.cep, cod_municipio: r.cod_municipio, logradouro: r.logradouro, numero: r.numero, complemento: r.complemento, bairro: r.bairro, cidade: r.municipio, uf: r.uf };
          if (!r.ativa) motivos.push(`situação na Receita: ${r.situacao ?? 'não ativa'}`);
          const faltaEnd = [!r.cep && 'CEP', !r.logradouro && 'logradouro', !r.numero && 'número', !r.cod_municipio && 'município (IBGE)'].filter(Boolean);
          if (faltaEnd.length) motivos.push(`endereço incompleto (${faltaEnd.join(', ')})`);
          if (!r.email) motivos.push('sem e-mail');
        } catch (e) {
          if (!d.nome) throw e;
          motivos.push(`Receita não respondeu (${(e as Error).message.replace(/\s*Preencha manualmente\.?/, '')}); preencher os dados`);
        }
      } else {
        if (!cpfValido(doc)) throw new ErroNegocio('CPF inválido.');
        if (!d.nome) throw new ErroNegocio('CPF precisa do nome.');
        motivos.push('CPF: preencher endereço e e-mail');
      }
      if (!d.nome) throw new ErroNegocio('Sem nome para cadastrar.');
      const insc = motivos.length ? motivos.join('; ') : 'cadastro criado por planilha';
      const r = db.prepare(`INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, email, fone, cep, cod_municipio, logradouro, numero, complemento, bairro, cidade, uf, conferir, conferir_motivo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(empresaId, doc.length === 14 ? 'CNPJ' : 'CPF', doc, d.nome.slice(0, 300), d.email ?? null, d.fone ?? null, d.cep ?? null, d.cod_municipio ?? null,
        d.logradouro ?? null, d.numero ?? null, d.complemento ?? null, d.bairro ?? null, d.cidade ?? null, d.uf ?? null, insc);
      res.push({ documento: doc, ok: true, id: Number(r.lastInsertRowid), nome: d.nome, mensagem: motivos.length ? `Criado; conferir: ${motivos.join('; ')}` : 'Criado; falta conferir.' });
    } catch (e) {
      res.push({ documento: doc, ok: false, mensagem: (e as Error).message });
    }
    if (doc.length === 14) await new Promise((r) => setTimeout(r, 250)); // respeita as bases públicas
  }
  return res;
}

// ---------------------------------------------------------------------------
// Importação para a Carteira: consulta o CNPJ e cria o cliente com o regime pela opção do Simples
// ---------------------------------------------------------------------------
const REGIME_DO_SIMPLES: Record<number, 'MEI' | 'SIMPLES' | 'PRESUMIDO'> = { 2: 'MEI', 3: 'SIMPLES', 1: 'PRESUMIDO' };

export async function importarParaCarteira(escritorioId: number, itens: { documento: string; nome?: string | null }[], buscar = consultarCnpj): Promise<ResultadoItem[]> {
  const res: ResultadoItem[] = [];
  const esc = db.prepare('SELECT cod_municipio, uf, cidade FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as any;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  for (const it of itens) {
    const doc = it.documento.replace(/\D/g, '');
    try {
      if (db.prepare('SELECT 1 FROM empresas WHERE escritorio_id = ? AND documento = ?').get(escritorioId, doc)) { res.push({ documento: doc, ok: false, mensagem: 'Já cadastrado.' }); continue; }
      const avisos: string[] = [];
      let d: any;
      if (doc.length === 14) {
        if (!cnpjValido(doc)) throw new ErroNegocio('CNPJ inválido.');
        const r = await buscar(doc);
        if (!r.cod_municipio) throw new ErroNegocio('A Receita não informou o município: cadastre este cliente à mão.');
        const regime = r.op_simp_nac ? REGIME_DO_SIMPLES[r.op_simp_nac] : 'SIMPLES';
        if (!r.op_simp_nac) avisos.push('regime não informado pela Receita (ficou Simples)');
        else if (regime === 'PRESUMIDO') avisos.push('não optante do Simples: ficou Lucro Presumido, confira se é Real');
        if (!r.ativa) avisos.push(`situação na Receita: ${r.situacao ?? 'não ativa'}`);
        d = { documento: doc, razao_social: r.razao_social || it.nome, nome_fantasia: r.nome_fantasia, cod_municipio: r.cod_municipio, uf: r.uf, email: r.email, cnae: r.cnae,
          regime, contato_fone: r.fone, cep: r.cep, logradouro: r.logradouro, numero: r.numero, complemento: r.complemento, bairro: r.bairro, cidade: r.municipio };
      } else {
        if (!cpfValido(doc)) throw new ErroNegocio('CPF inválido.');
        if (!it.nome) throw new ErroNegocio('CPF precisa do nome na planilha.');
        if (!esc?.cod_municipio) throw new ErroNegocio('Para CPF, cadastre antes a empresa do escritório (o município dela é usado).');
        d = { documento: doc, razao_social: it.nome, cod_municipio: esc.cod_municipio, uf: esc.uf, cidade: esc.cidade, regime: 'PF' };
        avisos.push('pessoa física: município do escritório, confira o endereço');
      }
      d.observacoes = `Importado de planilha em ${hoje.split('-').reverse().join('/')}: confira regime, perfil e responsável.`;
      const id = criarCliente(escritorioId, ClienteCarteira.parse(d));
      res.push({ documento: doc, ok: true, id, nome: d.razao_social, mensagem: avisos.length ? `Criado; conferir: ${avisos.join('; ')}` : 'Criado.' });
    } catch (e: any) {
      res.push({ documento: doc, ok: false, mensagem: e?.issues ? e.issues.map((x: any) => x.message).join('; ') : e.message });
    }
    if (doc.length === 14) await new Promise((r) => setTimeout(r, 250)); // respeita as bases públicas
  }
  return res;
}
