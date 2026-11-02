/**
 * Fontes de dados do Radar de Oportunidades. Cada fornecedor implementa `Provedor`; o resto do sistema só conhece
 * `EmpresaRadar`. Hoje: Casa dos Dados (API paga, dados públicos da Receita Federal) e uma base de DEMONSTRAÇÃO,
 * usada enquanto nenhuma chave está configurada (sempre identificada como demonstração na tela).
 */

export interface FiltrosRadar {
  texto?: string | null;          // razão social, nome fantasia ou CNPJ
  uf?: string | null;
  municipio?: string | null;
  aberturaDe?: string | null;     // AAAA-MM-DD
  aberturaAte?: string | null;
  cnae?: string | null;           // código (7 dígitos) ou começo dele
  atividade?: string | null;      // palavras na descrição da atividade
  situacao?: string | null;       // ATIVA, BAIXADA, INAPTA, SUSPENSA, NULA
  natureza?: string | null;       // código da natureza jurídica (ex.: 2062)
  porte?: string | null;          // ME, EPP, DEMAIS
  comTelefone?: boolean | null;
  comEmail?: boolean | null;
}

export interface EmpresaRadar {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  data_abertura: string | null;
  uf: string | null;
  municipio: string | null;
  cod_municipio: string | null;
  cnae: string | null;
  cnae_descricao: string | null;
  natureza_codigo: string | null;
  natureza_descricao: string | null;
  situacao: string | null;
  porte: string | null;
  telefone: string | null;
  email: string | null;
  endereco: { cep?: string | null; logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null };
  capital_social: number | null;
}

export interface ResultadoPesquisa { total: number; empresas: EmpresaRadar[] }

export interface Provedor {
  id: 'CASA_DOS_DADOS' | 'DEMONSTRACAO';
  nome: string;
  demonstracao: boolean;
  pesquisar(f: FiltrosRadar, pagina: number, limite: number): Promise<ResultadoPesquisa>;
  consultar(cnpj: string): Promise<EmpresaRadar | null>;
}

/** Erro de um fornecedor, com mensagem pronta para o usuário. */
export class ErroProvedor extends Error {
  constructor(msg: string, public status = 502) { super(msg); }
}

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
const so = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const txt = (v: unknown) => (v == null || v === '' ? null : String(v).trim() || null);
const PORTE_CD: Record<string, string[]> = { ME: ['01'], EPP: ['03'], DEMAIS: ['05'] };
const porteDe = (codigo: unknown, descricao: unknown) => {
  const c = String(codigo ?? ''), d = semAcento(String(descricao ?? '')).toUpperCase();
  if (c === '01' || /MICRO/.test(d)) return 'ME';
  if (c === '03' || /PEQUENO PORTE|EPP/.test(d)) return 'EPP';
  if (c === '05' || /DEMAIS/.test(d)) return 'DEMAIS';
  return d ? txt(descricao) : null;
};

// ---------------------------------------------------------------------------------------------
// Casa dos Dados (https://docs.casadosdados.com.br) — header api-key; pesquisa POST /v5/cnpj/pesquisa
// ---------------------------------------------------------------------------------------------

const SITUACOES = ['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA', 'NULA'];
/** Situação cadastral: aceita só os valores da Receita, em qualquer das formas em que a fonte a devolve (texto ou objeto). */
function situacaoDe(x: any): string | null {
  const s = x?.situacao_cadastral;
  const candidatos = [s, s?.situacao_cadastral, s?.situacao_atual, s?.situacao, s?.descricao, x?.descricao_situacao_cadastral, x?.situacao];
  for (const c of candidatos) {
    const v = semAcento(String(typeof c === 'string' || typeof c === 'number' ? c : '')).trim().toUpperCase();
    if (SITUACOES.includes(v)) return v;
    if (v === '02' || v === '2') return 'ATIVA'; // código da Receita: 01 nula, 02 ativa, 03 suspensa, 04 inapta, 08 baixada
    const cod: Record<string, string> = { '01': 'NULA', '1': 'NULA', '03': 'SUSPENSA', '3': 'SUSPENSA', '04': 'INAPTA', '4': 'INAPTA', '08': 'BAIXADA', '8': 'BAIXADA' };
    if (cod[v]) return cod[v];
  }
  return null;
}

/** Converte a empresa devolvida pela Casa dos Dados (os campos variam um pouco entre versões da API). */
export function deCasaDosDados(x: any): EmpresaRadar {
  const end = x?.endereco ?? {};
  const atv = x?.atividade_principal ?? x?.cnae_principal ?? x?.cnae_fiscal ?? null;
  const cnae = so(typeof atv === 'object' && atv ? atv.codigo ?? atv.code : atv ?? x?.codigo_atividade_principal) || null;
  const fones = ([] as any[]).concat(x?.contato_telefonico ?? x?.telefones ?? []).map((t: any) => (typeof t === 'string' ? t : t?.completo ?? `${t?.ddd ?? ''}${t?.numero ?? ''}`)).map(so).filter(Boolean);
  const emails = ([] as any[]).concat(x?.contato_email ?? x?.emails ?? []).map((e: any) => (typeof e === 'string' ? e : e?.email)).filter(Boolean);
  return {
    cnpj: so(x?.cnpj).padStart(14, '0'),
    razao_social: txt(x?.razao_social) ?? '(sem razão social)',
    nome_fantasia: txt(x?.nome_fantasia),
    data_abertura: txt(x?.data_abertura)?.slice(0, 10) ?? null,
    uf: txt(end.uf)?.toUpperCase() ?? null,
    municipio: txt(end.municipio),
    cod_municipio: txt(end.ibge?.codigo_municipio),
    cnae,
    cnae_descricao: typeof atv === 'object' && atv ? txt(atv.descricao ?? atv.description) : txt(x?.descricao_atividade_principal),
    natureza_codigo: txt(x?.codigo_natureza_juridica),
    natureza_descricao: txt(x?.descricao_natureza_juridica),
    situacao: situacaoDe(x),
    porte: porteDe(x?.porte_empresa?.codigo, x?.porte_empresa?.descricao),
    telefone: fones[0] ?? null,
    email: emails[0] ? String(emails[0]).toLowerCase() : null,
    endereco: { cep: txt(end.cep), logradouro: [txt(end.tipo_logradouro), txt(end.logradouro)].filter(Boolean).join(' ') || null, numero: txt(end.numero), complemento: txt(end.complemento), bairro: txt(end.bairro) },
    capital_social: x?.capital_social != null ? Number(x.capital_social) : null,
  };
}

/** Corpo da pesquisa avançada (v5) a partir dos filtros do Kontor. */
export function corpoCasaDosDados(f: FiltrosRadar, pagina: number, limite: number) {
  const c: any = { limite, pagina };
  const t = String(f.texto ?? '').trim();
  if (t && so(t).length >= 8 && so(t).length === t.replace(/[.\-/\s]/g, '').length) {
    if (so(t).length === 14) c.cnpj = [so(t)]; else c.cnpj_raiz = [so(t).slice(0, 8)];
  } else if (t) c.busca_textual = [{ texto: [t], tipo_busca: 'radical', razao_social: true, nome_fantasia: true, nome_socio: false }];
  if (f.uf) c.uf = [f.uf.toLowerCase()];
  if (f.municipio) c.municipio = [semAcento(f.municipio).toLowerCase()];
  if (f.aberturaDe || f.aberturaAte) c.data_abertura = { ...(f.aberturaDe ? { inicio: f.aberturaDe } : {}), ...(f.aberturaAte ? { fim: f.aberturaAte } : {}) };
  if (f.cnae) c.codigo_atividade_principal = [so(f.cnae)];
  if (f.situacao) c.situacao_cadastral = [f.situacao.toUpperCase()];
  if (f.natureza) c.codigo_natureza_juridica = [so(f.natureza)];
  if (f.porte && PORTE_CD[f.porte]) c.porte_empresa = { codigos: PORTE_CD[f.porte] };
  if (f.comTelefone || f.comEmail) c.mais_filtros = { ...(f.comTelefone ? { com_telefone: true } : {}), ...(f.comEmail ? { com_email: true } : {}) };
  return c;
}

type Fetch = typeof fetch;

export function casaDosDados(apiKey: string, fetcher: Fetch = fetch, base = 'https://api.casadosdados.com.br'): Provedor {
  const chamar = async (metodo: 'GET' | 'POST', caminho: string, corpo?: unknown) => {
    let r: Response;
    try {
      r = await fetcher(`${base}${caminho}`, { method: metodo, headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(30_000) });
    } catch (e: any) {
      throw new ErroProvedor(/abort|timeout/i.test(String(e?.name ?? e?.message)) ? 'A Casa dos Dados demorou demais para responder. Tente de novo em instantes.' : 'Sem conexão com a Casa dos Dados. Verifique a internet e tente de novo.', 503);
    }
    const texto = await r.text();
    let json: any = null; try { json = texto ? JSON.parse(texto) : null; } catch { /* corpo não JSON */ }
    if (r.status === 401) throw new ErroProvedor('A chave da Casa dos Dados está incorreta ou foi revogada. Confira em Radar > Configurar fonte de dados.', 401);
    if (r.status === 403) throw new ErroProvedor('A chave da Casa dos Dados não tem acesso a este recurso ou o saldo acabou. Confira o plano e o saldo no portal da Casa dos Dados.', 403);
    if (r.status === 429) throw new ErroProvedor('Limite de consultas da Casa dos Dados atingido. Aguarde alguns minutos.', 429);
    if (r.status === 404) return null;
    if (!r.ok) throw new ErroProvedor(`A Casa dos Dados respondeu com erro (${r.status})${json?.message ? `: ${json.message}` : ''}.`, r.status >= 500 ? 503 : 400);
    return json;
  };
  return {
    id: 'CASA_DOS_DADOS', nome: 'Casa dos Dados', demonstracao: false,
    async pesquisar(f, pagina, limite) {
      const j = await chamar('POST', '/v5/cnpj/pesquisa', corpoCasaDosDados(f, pagina, limite));
      const lista = ([] as any[]).concat(j?.cnpjs ?? j?.data ?? []);
      return { total: Number(j?.total ?? lista.length) || 0, empresas: lista.map(deCasaDosDados).filter((e) => e.cnpj.length === 14) };
    },
    async consultar(cnpj) {
      const j = await chamar('GET', `/v4/cnpj/${so(cnpj)}`);
      return j ? deCasaDosDados(j) : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Demonstração: empresas inventadas, marcadas como DEMONSTRAÇÃO, para testar a tela sem contratar fornecedor
// ---------------------------------------------------------------------------------------------

const dv = (base: string) => {
  const calc = (b: string, pesos: number[]) => { const s = b.split('').reduce((t, d, i) => t + Number(d) * pesos[i], 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = calc(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
};
const CIDADES: [string, string][] = [['Blumenau', '4202404'], ['Pomerode', '4213203'], ['Timbó', '4218202'], ['Indaial', '4207502'], ['Gaspar', '4205902'], ['Brusque', '4202909'], ['Joinville', '4209102'], ['Jaraguá do Sul', '4208906']];
const ATIVIDADES: [string, string, string][] = [
  ['6201501', 'Desenvolvimento de programas de computador sob encomenda', 'Tecnologia'], ['6204000', 'Consultoria em tecnologia da informação', 'Tecnologia'],
  ['4712100', 'Comércio varejista de mercadorias em geral', 'Comércio'], ['4781400', 'Comércio varejista de artigos do vestuário e acessórios', 'Comércio'],
  ['1412601', 'Confecção de peças do vestuário', 'Indústria'], ['2512800', 'Fabricação de esquadrias de metal', 'Indústria'],
  ['8599604', 'Treinamento em desenvolvimento profissional e gerencial', 'Educação'], ['8630503', 'Atividade médica ambulatorial restrita a consultas', 'Saúde'],
  ['7319002', 'Promoção de vendas', 'Serviços'], ['7020400', 'Atividades de consultoria em gestão empresarial', 'Serviços'],
  ['9313100', 'Atividades de condicionamento físico', 'Serviços'], ['4520001', 'Serviços de manutenção e reparação mecânica de veículos', 'Serviços'],
  ['5611201', 'Restaurantes e similares', 'Alimentação'], ['6822600', 'Gestão e administração da propriedade imobiliária', 'Imobiliário'],
];
const NOMES = ['Alfa', 'Beta', 'Horizonte', 'Vale', 'Norte', 'Aurora', 'Prisma', 'Delta', 'Sigma', 'Atlas', 'Orion', 'Nova', 'Ponte', 'Raiz', 'Ciclo', 'Trilha'];
const PORTES = ['ME', 'ME', 'ME', 'EPP', 'DEMAIS'];

/** 64 empresas fictícias, com abertura distribuída nos 120 dias antes de `hoje` (o CNPJ começa com 99). */
export function empresasDemonstracao(hoje = new Date()): EmpresaRadar[] {
  const l: EmpresaRadar[] = [];
  for (let i = 0; i < 64; i++) {
    const [cid, ibge] = CIDADES[i % CIDADES.length];
    const [cnae, desc, seg] = ATIVIDADES[(i * 5) % ATIVIDADES.length];
    const nome = `${NOMES[i % NOMES.length]} ${seg}`;
    const abertura = new Date(hoje.getTime() - ((i * 37) % 120) * 864e5 - (i >= 48 ? 400 * 864e5 : 0)).toISOString().slice(0, 10);
    l.push({
      cnpj: dv(`99${String(100000 + i * 731).padStart(6, '0')}0001`),
      razao_social: `${nome.toUpperCase()} LTDA (DEMONSTRAÇÃO)`, nome_fantasia: `${nome} (demonstração)`,
      data_abertura: abertura, uf: 'SC', municipio: cid, cod_municipio: ibge, cnae, cnae_descricao: desc,
      natureza_codigo: i % 3 ? '2062' : '2135', natureza_descricao: i % 3 ? 'Sociedade Empresária Limitada' : 'Empresário (Individual)',
      situacao: i % 11 === 10 ? 'BAIXADA' : 'ATIVA', porte: PORTES[i % PORTES.length],
      telefone: null, email: null, endereco: { cep: null, logradouro: 'Endereço de demonstração', numero: String(100 + i), complemento: null, bairro: 'Centro' }, capital_social: 10000 + i * 1000,
    });
  }
  return l;
}

export function demonstracao(hoje = new Date()): Provedor {
  const base = () => empresasDemonstracao(hoje);
  const norm = (s: string | null | undefined) => semAcento(String(s ?? '')).toLowerCase();
  return {
    id: 'DEMONSTRACAO', nome: 'Demonstração', demonstracao: true,
    async pesquisar(f, pagina, limite) {
      const t = norm(f.texto), dig = so(f.texto);
      const l = base().filter((e) => (!t || norm(e.razao_social).includes(t) || norm(e.nome_fantasia).includes(t) || (dig.length >= 4 && e.cnpj.includes(dig)))
        && (!f.uf || e.uf === f.uf.toUpperCase()) && (!f.municipio || norm(e.municipio) === norm(f.municipio))
        && (!f.aberturaDe || (e.data_abertura ?? '') >= f.aberturaDe) && (!f.aberturaAte || (e.data_abertura ?? '') <= f.aberturaAte)
        && (!f.cnae || (e.cnae ?? '').startsWith(so(f.cnae))) && (!f.atividade || norm(e.cnae_descricao).includes(norm(f.atividade)))
        && (!f.situacao || e.situacao === f.situacao.toUpperCase()) && (!f.natureza || e.natureza_codigo === so(f.natureza)) && (!f.porte || e.porte === f.porte)
        && (!f.comTelefone || !!e.telefone) && (!f.comEmail || !!e.email))
        .sort((a, b) => (b.data_abertura ?? '').localeCompare(a.data_abertura ?? ''));
      return { total: l.length, empresas: l.slice((pagina - 1) * limite, pagina * limite) };
    },
    async consultar(cnpj) { return base().find((e) => e.cnpj === so(cnpj)) ?? null; },
  };
}
