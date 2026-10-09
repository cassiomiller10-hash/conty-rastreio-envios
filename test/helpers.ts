import { createFakeTrackingClient } from "../src/agregador/rastreio-falso.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { type Checkpoint, FakeAggregator } from "../src/simulador/agregador-falso.ts";
import type { Carrier } from "../src/transportadoras.ts";

export const API_KEY = "chave-de-teste";

/**
 * API + agregador falso como serviço HTTP (o cliente fala HTTP com ele pelo `fetchFn`) e relógio
 * controlado. `carriers` permite simular uma mudança na tabela de códigos.
 */
export function setup(options: { now?: string; carriers?: Record<string, Carrier>; timeoutMs?: number; db?: ReturnType<typeof openDatabase>; aggregator?: FakeAggregator } = {}) {
  let now = new Date(options.now ?? "2026-10-01T09:00:00-03:00");
  const db = options.db ?? openDatabase(":memory:");
  const aggregator = options.aggregator ?? new FakeAggregator(API_KEY);
  const provider = createFakeTrackingClient({
    baseUrl: "http://agregador.test",
    apiKey: API_KEY,
    timeoutMs: options.timeoutMs ?? 2_000,
    fetchFn: (input, init) => Promise.resolve(aggregator.app.request(input, init)),
  });
  const app = createApp(db, provider, { now: () => now, ...(options.carriers ? { carriers: options.carriers } : {}) });

  async function call(method: string, path: string, payload?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    // biome-ignore lint: corpo genérico nos testes
    return { status: res.status, body: (await res.json()) as any };
  }

  const api = {
    db,
    aggregator,
    setNow(iso: string) {
      now = new Date(iso);
    },
    get: (path: string) => call("GET", path),
    post: (path: string, payload?: unknown) => call("POST", path, payload),
    /** Cadastra o envio (Correios PAC por padrão) e devolve o id. */
    async register(codigo = "QB123456789BR", extra: Record<string, unknown> = {}) {
      const res = await call("POST", "/envios", {
        campanha_id: "camp_verao26",
        criador_id: "cri_ana",
        transportadora: "correios",
        modalidade: "PAC",
        codigo,
        ...extra,
      });
      if (res.status >= 300) throw new Error(`cadastro falhou: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.envio as string;
    },
    /** Checkpoint no agregador, no formato dele. */
    checkpoint(codigo: string, time: string, rawStatus: string, message: string, location: string | null, tag: string | null, courier = "correios") {
      aggregator.addCheckpoint(courier, codigo, { checkpoint_time: time, raw_status: rawStatus, message, location, tag } as Checkpoint);
    },
    consult: (envio: string) => call("POST", `/envios/${envio}/consultar`),
    view: (envio: string) => call("GET", `/envios/${envio}`),
    check: () => call("POST", "/verificacoes"),
    notices: (tipo?: string) => call("GET", `/avisos${tipo ? `?tipo=${tipo}` : ""}`),
  };
  return api;
}

export type Api = ReturnType<typeof setup>;

/** Checkpoints típicos dos Correios (hora sem fuso, como as transportadoras mandam). */
export const CP = {
  postado: ["PO-01", "Objeto postado", "São Paulo/SP", "InfoReceived"] as const,
  transito: ["RO-01", "Objeto em trânsito - por favor aguarde", "Cajamar/SP", "InTransit"] as const,
  saiu: ["OEC-01", "Objeto saiu para entrega ao destinatário", "Campinas/SP", "OutForDelivery"] as const,
  entregue: ["BDE-01", "Objeto entregue ao destinatário", "Campinas/SP", "Delivered"] as const,
  ausente: ["BDE-20", "Destinatário ausente - nova tentativa", "Campinas/SP", "AttemptFail"] as const,
};

export function add(api: Api, codigo: string, time: string, cp: readonly [string, string, string, string]) {
  api.checkpoint(codigo, time, cp[0], cp[1], cp[2], cp[3]);
}
