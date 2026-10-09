import type { Status } from "../status.ts";

// O contrato entre a regra de negócio e qualquer agregador de rastreio. Daqui para dentro, nada
// sabe qual agregador está sendo usado: trocar de agregador é escrever outro cliente que devolva
// estes tipos.

/** Evento no formato padronizado da Conty. */
export type StandardEvent = {
  codigoBruto: string;
  descricao: string;
  /** Data como a transportadora informou: ISO com fuso, ou hora local sem fuso. */
  data: string;
  local: string | null;
  /** Só informativo: alguns agregadores trocam o id do evento a cada consulta. */
  idAgregador: string | null;
  /** Categoria genérica do agregador já convertida para o nosso vocabulário (ou null). */
  sugestao: Status | null;
  /** Nome original da categoria, só para explicar decisões. */
  categoriaAgregador: string | null;
};

export type StandardTracking = {
  eventos: StandardEvent[];
  /** Previsão de entrega da transportadora (AAAA-MM-DD), quando o agregador informa. */
  previsaoEntrega: string | null;
};

export type ShipmentRef = { transportadora: string; modalidade: string; codigo: string };

export interface TrackingProvider {
  readonly nome: string;
  register(shipment: ShipmentRef): Promise<void>;
  fetchTracking(shipment: Pick<ShipmentRef, "transportadora" | "codigo">): Promise<StandardTracking>;
}

export type ProviderFailureKind = "tempo_esgotado" | "http" | "formato" | "rede";

export class ProviderFailure extends Error {
  constructor(
    readonly tipo: ProviderFailureKind,
    message: string,
  ) {
    super(message);
  }
}
