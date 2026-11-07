// ---------------------------------------------------------------------------
// Contrato dos conectores bancários. O núcleo da cobrança conhece só este contrato;
// o que é próprio de cada banco (layout, códigos de ocorrência, endpoints, nosso número) fica no conector dele.
// Valores sempre em centavos inteiros e datas em ISO (AAAA-MM-DD).
// ---------------------------------------------------------------------------

/** Estados do registro no banco (tabela registros_bancarios). Registrado, Liquidado e Baixado só com confirmação do banco. */
export const ESTADOS_REGISTRO = ['AGUARDANDO_REGISTRO', 'EM_PROCESSAMENTO', 'RESULTADO_DESCONHECIDO', 'REGISTRADO', 'REJEITADO', 'BAIXA_SOLICITADA', 'BAIXADO', 'LIQUIDADO', 'EM_ANALISE'] as const;
export type EstadoRegistro = (typeof ESTADOS_REGISTRO)[number];

/** Transições válidas. EM_ANALISE pode vir de qualquer estado (ocorrência desconhecida ou divergência). */
export const TRANSICOES: Record<EstadoRegistro, EstadoRegistro[]> = {
  AGUARDANDO_REGISTRO: ['EM_PROCESSAMENTO'],
  EM_PROCESSAMENTO: ['REGISTRADO', 'REJEITADO', 'RESULTADO_DESCONHECIDO', 'LIQUIDADO'],
  RESULTADO_DESCONHECIDO: ['REGISTRADO', 'REJEITADO', 'EM_PROCESSAMENTO', 'LIQUIDADO'],
  REGISTRADO: ['LIQUIDADO', 'BAIXA_SOLICITADA', 'BAIXADO'],
  REJEITADO: [],
  BAIXA_SOLICITADA: ['BAIXADO', 'REGISTRADO', 'LIQUIDADO'],
  BAIXADO: [],
  LIQUIDADO: [],
  EM_ANALISE: ['REGISTRADO', 'LIQUIDADO', 'BAIXADO', 'REJEITADO'],
};
export const podeTransitar = (de: EstadoRegistro, para: EstadoRegistro) => para === 'EM_ANALISE' || de === para || TRANSICOES[de].includes(para);

export type Modalidade = 'CNAB' | 'API';
export type Operacao = 'registrar' | 'consultar' | 'alterar' | 'baixar' | 'remessa' | 'retorno' | 'notificacao' | 'pixHibrido';

/** Conta de cobrança como o conector recebe (segredos já decifrados só quando a operação precisa). */
export interface ContaConector {
  id: number; banco: string; modalidade: Modalidade; layout: string | null; ambiente: 'HOMOLOGACAO' | 'PRODUCAO';
  agencia: string; agenciaDv: string; conta: string; contaDv: string; convenio: string; carteira: string;
  parametros: Record<string, unknown>;
  beneficiario: { documento: string; nome: string };
}

export interface PagadorConector { documento: string; nome: string; endereco: string; bairro: string; cep: string; cidade: string; uf: string }

/** Título normalizado pelo núcleo, igual para todos os bancos. */
export interface TituloConector {
  cobrancaId: number; nossoNumero: string; numeroDocumento: string;
  emissao: string; vencimento: string; valorCentavos: number;
  multaPct: number; jurosPctMes: number; descontoCentavos: number; descontoAte: string | null;
  mensagens: string[]; pagador: PagadorConector;
  /** Instrução que vai junto (CNAB): entrada, baixa ou alteração de vencimento. */
  movimento: 'ENTRADA' | 'BAIXA' | 'ALTERAR_VENCIMENTO';
}

/** Evento devolvido pelo banco (retorno, consulta ou notificação), com o código original preservado. */
export interface EventoBanco {
  nossoNumero: string; codigo: string; descricao: string; motivos: string[];
  estado: EstadoRegistro | null; // null = ocorrência desconhecida → EM_ANALISE
  dataEvento: string | null; dataCredito: string | null;
  valorPagoCentavos: number | null; tarifaCentavos: number | null;
  linhaDigitavel?: string | null; pixCopiaCola?: string | null;
}

export type ErroConector = 'CREDENCIAL' | 'VALIDACAO' | 'TEMPORARIO' | 'RESULTADO_DESCONHECIDO' | 'NAO_SUPORTADO' | 'ESTADO_INVALIDO' | 'ARQUIVO_INVALIDO' | 'ASSINATURA_INVALIDA';
export class FalhaConector extends Error {
  constructor(public tipo: ErroConector, mensagem: string, public detalhe?: unknown) { super(mensagem); }
}

export interface Conector {
  banco: string; // código usado em contas_cobranca.banco
  nome: string; // nome para a tela
  codigoCompensacao: string; // ex.: '033'
  capacidades(modalidade: Modalidade): Operacao[];
  /** Nosso número completo (com dígito, se o banco usar) a partir da sequência da conta. */
  nossoNumero(conta: ContaConector, sequencia: number): string;
  /** Linha digitável e código de barras calculados do título (CNAB: o boleto é impresso pelo Kontor). */
  codigoBarras?(conta: ContaConector, titulo: TituloConector): { codigoBarras: string; linhaDigitavel: string };
  gerarRemessa?(conta: ContaConector, numeroArquivo: number, agora: Date, titulos: TituloConector[]): string;
  lerRetorno?(conta: ContaConector, texto: string): { numeroArquivo: number | null; eventos: EventoBanco[] };
  registrar?(conta: ContaConector, titulo: TituloConector, chaveIdempotencia: string): Promise<EventoBanco>;
  consultar?(conta: ContaConector, nossoNumero: string): Promise<EventoBanco>;
  baixar?(conta: ContaConector, nossoNumero: string, chaveIdempotencia: string): Promise<EventoBanco>;
  alterar?(conta: ContaConector, nossoNumero: string, mudanca: { vencimento?: string; valorCentavos?: number }, chaveIdempotencia: string): Promise<EventoBanco>;
}

/** Catálogo dos conectores disponíveis nesta versão. Cada banco entra aqui quando estiver homologado. */
export const CONECTORES: Record<string, Conector> = {};
export const conectorDe = (banco: string): Conector => {
  const c = CONECTORES[banco];
  if (!c) throw new FalhaConector('NAO_SUPORTADO', `O banco ${banco} ainda não está disponível nesta versão do Kontor.`);
  return c;
};
