export const STATUS = ["postado", "em_transito", "saiu_para_entrega", "entregue", "excecao"] as const;
export type Status = (typeof STATUS)[number];

export const ROTULO: Record<Status, string> = {
  postado: "postado",
  em_transito: "em trânsito",
  saiu_para_entrega: "saiu para entrega",
  entregue: "entregue",
  excecao: "exceção",
};

/** Empate de horário: vence a etapa mais informativa. */
export const INFORMATIVIDADE: Record<Status, number> = {
  entregue: 5,
  excecao: 4,
  saiu_para_entrega: 3,
  em_transito: 2,
  postado: 1,
};

/**
 * Status que mexem em prazo: "postado" liga o relógio do atraso e "entregue" dispara o prazo do
 * conteúdo. Só podem vir da tabela conferida pela Conty, nunca da categoria genérica do agregador.
 */
export const SO_DA_TABELA: ReadonlySet<Status> = new Set<Status>(["postado", "entregue"]);
