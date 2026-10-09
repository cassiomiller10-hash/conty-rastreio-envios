import type { Status } from "../status.ts";
import {
  ProviderFailure,
  type ShipmentRef,
  type StandardEvent,
  type StandardTracking,
  type TrackingProvider,
} from "./provedor.ts";

// Cliente HTTP do agregador fictício "Rastreio Falso". Este é o ÚNICO arquivo do sistema que
// conhece o formato dele (rotas, nomes de campo, categorias, datas). Trocar de agregador = escrever
// outro arquivo como este, que devolva StandardTracking.

/** Categorias do agregador no nosso vocabulário. A regra decide depois o que aceitar. */
const CATEGORIES: Record<string, Status> = {
  InfoReceived: "postado",
  InTransit: "em_transito",
  OutForDelivery: "saiu_para_entrega",
  AttemptFail: "excecao",
  Exception: "excecao",
  AvailableForPickup: "excecao",
  Delivered: "entregue",
};

type Options = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
};

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure("formato", `${where}: objeto esperado`);
  return value as Json;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProviderFailure("formato", `${where}: texto esperado`);
  return value;
}

function toEvent(raw: unknown): StandardEvent {
  const checkpoint = object(raw, "checkpoint");
  const tag = typeof checkpoint.tag === "string" ? checkpoint.tag : null;
  return {
    codigoBruto: text(checkpoint.raw_status, "raw_status"),
    descricao: typeof checkpoint.message === "string" ? checkpoint.message : "",
    data: text(checkpoint.checkpoint_time, "checkpoint_time"),
    local: typeof checkpoint.location === "string" && checkpoint.location.trim() ? checkpoint.location : null,
    idAgregador: typeof checkpoint.id === "string" ? checkpoint.id : null,
    sugestao: tag ? (CATEGORIES[tag] ?? null) : null,
    categoriaAgregador: tag,
  };
}

export function createFakeTrackingClient(options: Options): TrackingProvider {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  /** Chamada com tempo máximo: se o agregador não responder, cancela e falha com erro claro. */
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderFailure("tempo_esgotado", `o agregador não respondeu em ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchFn(`${options.baseUrl}${path}`, {
          method,
          headers: { "x-api-key": options.apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        }),
        timeout,
      ]).catch((error: unknown) => {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure("rede", `falha de rede ao chamar o agregador: ${error instanceof Error ? error.message : String(error)}`);
      });
      const json = await Promise.race([response.json().catch(() => null), timeout]);
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    nome: "rastreio-falso",

    async register(shipment: ShipmentRef) {
      const { status } = await call("POST", "/v1/trackings", {
        tracking_number: shipment.codigo,
        courier: shipment.transportadora,
        service: shipment.modalidade,
      });
      // 409 = já cadastrado lá: para nós, cadastrar é idempotente.
      if (status !== 201 && status !== 200 && status !== 409) {
        throw new ProviderFailure("http", `o agregador respondeu ${status} ao cadastrar`);
      }
    },

    async fetchTracking(shipment): Promise<StandardTracking> {
      const path = `/v1/trackings/${encodeURIComponent(shipment.transportadora)}/${encodeURIComponent(shipment.codigo)}`;
      const { status, json } = await call("GET", path);
      if (status !== 200) throw new ProviderFailure("http", `o agregador respondeu ${status} à consulta`);
      const tracking = object(json, "tracking");
      const checkpoints = Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [];
      const expected = tracking.expected_delivery;
      return {
        eventos: checkpoints.map(toEvent),
        previsaoEntrega: typeof expected === "string" && /^\d{4}-\d{2}-\d{2}/.test(expected) ? expected.slice(0, 10) : null,
      };
    },
  };
}
