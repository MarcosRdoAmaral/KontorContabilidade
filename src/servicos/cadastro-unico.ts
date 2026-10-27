import { db } from '../db.js';

/**
 * Cadastro único de clientes: a Carteira é o cadastro principal. Cada cliente da carteira aparece sozinho em
 * "Clientes" da empresa do escritório (o tomador usado para faturar os honorários), ligado por
 * tomadores.carteira_empresa_id. Os dados de identificação, contato e endereço vêm sempre da Carteira; o que é só
 * do faturamento (forma de cobrança, vencimento, serviços padrão, descontos, descrição da nota) continua em Clientes.
 */

/** Campos do tomador que vêm da carteira: [coluna do tomador, coluna da empresa]. */
export const CAMPOS_DA_CARTEIRA = [
  ['inscricao_municipal', 'inscricao_municipal'], ['email', 'email'], ['fone', 'contato_fone'], ['cep', 'cep'], ['cod_municipio', 'cod_municipio'],
  ['logradouro', 'logradouro'], ['numero', 'numero'], ['complemento', 'complemento'], ['bairro', 'bairro'], ['cidade', 'cidade'], ['uf', 'uf'],
] as const;
/** Os mesmos, com documento e nome, como aparecem no formulário de Clientes (bloqueados quando ligados). */
export const CAMPOS_BLOQUEADOS = ['tipo_doc', 'documento', 'nome', ...CAMPOS_DA_CARTEIRA.map(([t]) => t)];

export function empresaDoEscritorio(escritorioId: number): number | null {
  return (db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND eh_escritorio = 1').get(escritorioId) as { id: number } | undefined)?.id ?? null;
}

const tipoDoc = (doc: string) => (doc.length === 14 ? 'CNPJ' : 'CPF');

/**
 * Cria ou atualiza o cliente (tomador) da empresa do escritório a partir do cliente da carteira.
 * Na primeira ligação com um cliente que já existia em Clientes (mesmo CNPJ/CPF), o que a carteira não tinha
 * (e-mail, telefone, endereço…) é trazido do cadastro antigo antes, para nada se perder.
 * Devolve o id do tomador, ou null quando não se aplica (sem empresa do escritório, ou é o próprio escritório).
 */
export function sincronizarClienteNoCadastro(escritorioId: number, empresaId: number): number | null {
  const esc = empresaDoEscritorio(escritorioId);
  if (!esc || esc === empresaId) return null;
  return db.transaction(() => {
    let e = db.prepare('SELECT * FROM empresas WHERE id = ? AND escritorio_id = ?').get(empresaId, escritorioId) as any;
    if (!e) return null;
    let t = db.prepare('SELECT * FROM tomadores WHERE empresa_id = ? AND carteira_empresa_id = ?').get(esc, empresaId) as any;
    if (!t) {
      t = db.prepare('SELECT * FROM tomadores WHERE empresa_id = ? AND documento = ? AND carteira_empresa_id IS NULL ORDER BY id LIMIT 1').get(esc, e.documento) as any;
      if (t) {
        // completa a carteira com o que só o cadastro antigo tinha
        const faltam = CAMPOS_DA_CARTEIRA.filter(([tc, ec]) => (e[ec] == null || e[ec] === '') && t[tc] != null && t[tc] !== '');
        if (faltam.length) {
          db.prepare(`UPDATE empresas SET ${faltam.map(([, ec]) => `${ec} = ?`).join(', ')} WHERE id = ?`).run(...faltam.map(([tc]) => t[tc]), empresaId);
          e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId) as any;
        }
      }
    }
    const valores = CAMPOS_DA_CARTEIRA.map(([, ec]) => e[ec] ?? null);
    if (t) {
      db.prepare(`UPDATE tomadores SET carteira_empresa_id = ?, tipo_doc = ?, documento = ?, nome = ?, ${CAMPOS_DA_CARTEIRA.map(([tc]) => `${tc} = ?`).join(', ')} WHERE id = ?`)
        .run(empresaId, tipoDoc(e.documento), e.documento, e.razao_social, ...valores, t.id);
      // a marca "falta conferir" por falta de endereço sai quando o endereço é completado na carteira
      if (e.cep && e.logradouro && e.bairro && e.cod_municipio) db.prepare("UPDATE tomadores SET conferir = 0, conferir_motivo = NULL WHERE id = ? AND conferir = 1 AND conferir_motivo LIKE '%endereço%'").run(t.id);
      return t.id as number;
    }
    const r = db.prepare(`INSERT INTO tomadores (empresa_id, carteira_empresa_id, tipo_doc, documento, nome, ${CAMPOS_DA_CARTEIRA.map(([tc]) => tc).join(', ')}, enviar_email_auto)
      VALUES (?,?,?,?,?,${CAMPOS_DA_CARTEIRA.map(() => '?').join(',')},?)`).run(esc, empresaId, tipoDoc(e.documento), e.documento, e.razao_social, ...valores, e.email ? 1 : 0);
    return Number(r.lastInsertRowid);
  })();
}

/** Liga todos os clientes da carteira ao cadastro de Clientes do escritório (idempotente; roda ao abrir o sistema). */
export function sincronizarCarteiraInteira(escritorioId: number): number {
  const esc = empresaDoEscritorio(escritorioId);
  if (!esc) return 0;
  const ids = (db.prepare('SELECT id FROM empresas WHERE escritorio_id = ? AND id != ?').all(escritorioId, esc) as { id: number }[]).map((r) => r.id);
  for (const id of ids) sincronizarClienteNoCadastro(escritorioId, id);
  // tomadores ligados a empresas de outro escritório-empresa (o escritório mudou de empresa) ficam soltos
  db.prepare('UPDATE tomadores SET carteira_empresa_id = NULL WHERE carteira_empresa_id IS NOT NULL AND empresa_id IN (SELECT id FROM empresas WHERE escritorio_id = ? AND id != ?)').run(escritorioId, esc);
  return ids.length;
}

export function sincronizarTodosOsEscritorios() {
  for (const { id } of db.prepare('SELECT id FROM escritorios').all() as { id: number }[]) sincronizarCarteiraInteira(id);
}

/** Clientes cadastrados só em "Clientes" do escritório, que ainda não estão na carteira. */
export function clientesForaDaCarteira(escritorioId: number) {
  const esc = empresaDoEscritorio(escritorioId);
  if (!esc) return [];
  const linhas = db.prepare(`SELECT t.id, t.tipo_doc, t.documento, t.nome, t.email, t.fone, t.cod_municipio, t.cidade, t.uf, t.cep, t.logradouro
    FROM tomadores t WHERE t.empresa_id = ? AND t.carteira_empresa_id IS NULL AND t.tipo_doc != 'SEM' AND t.documento IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM empresas e WHERE e.escritorio_id = ? AND e.documento = t.documento)
    ORDER BY t.nome, t.id`).all(esc, escritorioId) as any[];
  // o mesmo CNPJ/CPF cadastrado duas vezes em Clientes entra na carteira uma vez só (o primeiro cadastro é ligado)
  const primeiro = new Map<string, number>();
  for (const t of linhas) primeiro.set(t.documento, Math.min(primeiro.get(t.documento) ?? Infinity, t.id));
  return linhas.filter((t) => primeiro.get(t.documento) === t.id);
}
