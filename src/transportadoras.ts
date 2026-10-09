import type { Status } from "./status.ts";

// Tabela conferida pela Conty: para cada transportadora, o que cada código bruto significa.
// Três saídas possíveis por código:
//   - um dos 5 status;
//   - "ignorar": código conhecido que não é nenhum dos 5 (ex.: etiqueta emitida) e não muda nada;
//   - ausente: código não reconhecido, que vai para revisão.
// Os códigos e descrições são fictícios, no estilo dos de verdade.

export type Translation = Status | "ignorar";

export type Carrier = {
  id: string;
  nome: string;
  /** Fuso usado quando a transportadora manda a hora sem fuso. */
  fuso: string;
  codigos: Record<string, { traducao: Translation; descricao: string }>;
  /** Limite de dias úteis em trânsito por modalidade, usado quando não há previsão da transportadora. */
  limites: Record<string, number>;
  limitePadrao: number;
};

export const CARRIERS: Record<string, Carrier> = {
  correios: {
    id: "correios",
    nome: "Correios",
    fuso: "America/Sao_Paulo",
    codigos: {
      "ETQ-01": { traducao: "ignorar", descricao: "Etiqueta emitida, aguardando postagem" },
      "PO-01": { traducao: "postado", descricao: "Objeto postado" },
      "RO-01": { traducao: "em_transito", descricao: "Objeto em trânsito - por favor aguarde" },
      "DO-01": { traducao: "em_transito", descricao: "Objeto encaminhado para a unidade de distribuição" },
      "OEC-01": { traducao: "saiu_para_entrega", descricao: "Objeto saiu para entrega ao destinatário" },
      "BDE-01": { traducao: "entregue", descricao: "Objeto entregue ao destinatário" },
      "BDE-20": { traducao: "excecao", descricao: "Destinatário ausente - nova tentativa" },
      "FC-04": { traducao: "excecao", descricao: "Endereço incorreto" },
      "LDI-01": { traducao: "excecao", descricao: "Objeto aguardando retirada no endereço indicado" },
      // Devolução usa o mesmo código e termina "entregue"... ao remetente. Para o criador, é problema.
      "BDR-01": { traducao: "excecao", descricao: "Objeto devolvido e entregue ao remetente" },
      "EXT-01": { traducao: "excecao", descricao: "Objeto extraviado" },
    },
    limites: { PAC: 7, SEDEX: 3 },
    limitePadrao: 7,
  },
  jadlog: {
    id: "jadlog",
    nome: "Jadlog",
    fuso: "America/Sao_Paulo",
    codigos: {
      EMISSAO: { traducao: "ignorar", descricao: "Emissão de etiqueta" },
      COLETA: { traducao: "postado", descricao: "Coletado" },
      TRANSFERENCIA: { traducao: "em_transito", descricao: "Em transferência" },
      "EM ROTA": { traducao: "saiu_para_entrega", descricao: "Em rota de entrega" },
      ENTREGUE: { traducao: "entregue", descricao: "Entregue" },
      INSUCESSO: { traducao: "excecao", descricao: "Insucesso na entrega" },
      DEVOLUCAO: { traducao: "excecao", descricao: "Em devolução ao remetente" },
    },
    limites: { ".PACKAGE": 5, ".COM": 3 },
    limitePadrao: 5,
  },
};

/** Feriados nacionais (lista configurável). */
export const NATIONAL_HOLIDAYS_2026 = [
  "2026-01-01",
  "2026-04-03",
  "2026-04-21",
  "2026-05-01",
  "2026-09-07",
  "2026-10-12",
  "2026-11-02",
  "2026-11-15",
  "2026-11-20",
  "2026-12-25",
];

export function normalizeRawCode(code: string): string {
  return code.trim().toUpperCase();
}
