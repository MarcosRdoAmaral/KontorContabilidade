import https from 'node:https';
import { ADN_URL } from '../config.js';
import type { CertificadoA1 } from './certificado.js';
import { ungzipB64 } from './sefin.js';

/**
 * Cliente da distribuição de documentos do Ambiente de Dados Nacional (ADN) da NFS-e:
 * GET /contribuintes/DFe/{NSU} com o certificado A1 do contribuinte (TLS mútuo).
 * Devolve até 50 documentos com NSU maior que o informado: NFS-e e eventos em que o CNPJ é parte.
 */

export interface DocAdn { nsu: number; chave: string | null; tipoDocumento: string; tipoEvento: string | null; xml: string; geradoEm: string | null }
export interface RespostaAdn {
  http: number;
  situacao: 'DOCUMENTOS' | 'NENHUM' | 'REJEICAO' | 'LIMITE' | 'ERRO';
  docs: DocAdn[];
  erros: string[];
}
export type ConsultaAdn = (nsu: number) => Promise<{ status: number; corpo: any }>;

/** Interpreta a resposta do ADN (os nomes dos campos variam entre maiúsculas e minúsculas). */
export function lerRespostaAdn(status: number, corpo: any): RespostaAdn {
  const pegar = (o: any, ...nomes: string[]) => { for (const n of nomes) { if (o?.[n] !== undefined) return o[n]; const k = Object.keys(o ?? {}).find((x) => x.toLowerCase() === n.toLowerCase()); if (k) return o[k]; } return undefined; };
  const erros = ([] as any[]).concat(pegar(corpo, 'Erros', 'erros') ?? []).filter(Boolean)
    .map((e: any) => [pegar(e, 'Codigo', 'codigo'), pegar(e, 'Descricao', 'descricao', 'mensagem') ?? (typeof e === 'string' ? e : JSON.stringify(e))].filter(Boolean).join(' - '));
  if (status === 429) return { http: status, situacao: 'LIMITE', docs: [], erros: erros.length ? erros : ['Muitas consultas seguidas: o ADN pediu para aguardar.'] };
  const sp = String(pegar(corpo, 'StatusProcessamento') ?? '').toUpperCase();
  const lote = ([] as any[]).concat(pegar(corpo, 'LoteDFe', 'loteDFe') ?? []);
  const docs: DocAdn[] = [];
  for (const d of lote) {
    const b64 = pegar(d, 'ArquivoXml', 'arquivoXml');
    if (!b64) continue;
    let xml: string;
    try { xml = ungzipB64(String(b64)); } catch { try { xml = Buffer.from(String(b64), 'base64').toString('utf8'); } catch { continue; } }
    docs.push({ nsu: Number(pegar(d, 'NSU', 'nsu')) || 0, chave: pegar(d, 'ChaveAcesso', 'chaveAcesso') ?? null, tipoDocumento: String(pegar(d, 'TipoDocumento') ?? '').toUpperCase(),
      tipoEvento: pegar(d, 'TipoEvento') != null ? String(pegar(d, 'TipoEvento')) : null, xml, geradoEm: pegar(d, 'DataHoraGeracao') ?? null });
  }
  if (docs.length) return { http: status, situacao: 'DOCUMENTOS', docs, erros };
  if (sp.includes('NENHUM') || status === 404 || status === 204) return { http: status, situacao: 'NENHUM', docs: [], erros: [] };
  if (sp.includes('REJEI') || status === 400) return { http: status, situacao: 'REJEICAO', docs: [], erros: erros.length ? erros : ['O ADN rejeitou a consulta.'] };
  if (status >= 200 && status < 300) return { http: status, situacao: 'NENHUM', docs: [], erros: [] };
  return { http: status, situacao: 'ERRO', docs: [], erros: erros.length ? erros : [`O ADN respondeu com erro ${status}.`] };
}

/** Consulta real ao ADN (produção: as notas dos clientes só existem lá). */
export function consultaAdn(cert: CertificadoA1, ambiente: 1 | 2 = 1): { consultar: ConsultaAdn; fechar: () => void } {
  const base = process.env.ADN_URL_TESTE ?? ADN_URL[ambiente];
  const agent = new https.Agent({ key: cert.chavePem, cert: cert.cadeiaPem, keepAlive: true, rejectUnauthorized: !process.env.ADN_URL_TESTE });
  const consultar: ConsultaAdn = (nsu) => new Promise((resolve, reject) => {
    const r = https.request(`${base}/DFe/${nsu}`, { method: 'GET', agent, headers: { Accept: 'application/json' }, timeout: 60_000 }, (res) => {
      const partes: Buffer[] = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const bruto = Buffer.concat(partes).toString('utf8');
        let corpo: any = null;
        try { corpo = bruto ? JSON.parse(bruto) : null; } catch { corpo = null; }
        resolve({ status: res.statusCode ?? 0, corpo });
      });
    });
    r.on('timeout', () => r.destroy(new Error('Tempo esgotado aguardando o Ambiente de Dados Nacional (ADN).')));
    r.on('error', reject);
    r.end();
  });
  return { consultar, fechar: () => agent.destroy() };
}
