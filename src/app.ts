import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ProviderFailure, type TrackingProvider } from "./agregador/provedor.ts";
import {
  type Deps,
  listNotices,
  pendingCodes,
  refreshShipment,
  registerShipment,
  RequestError,
  runCheck,
  shipmentView,
} from "./envios.ts";
import { CARRIERS, type Carrier, NATIONAL_HOLIDAYS_2026 } from "./transportadoras.ts";

type Options = {
  now?: () => Date;
  carriers?: Record<string, Carrier>;
  holidays?: string[];
  diasParaPostagem?: number;
};

/** O provedor entra pela interface: a API não sabe qual agregador está atrás dele. */
export function createApp(db: DatabaseSync, provider: TrackingProvider, options: Options = {}) {
  const deps: Deps = {
    db,
    provider,
    carriers: options.carriers ?? CARRIERS,
    holidays: new Set(options.holidays ?? NATIONAL_HOLIDAYS_2026),
    diasParaPostagem: options.diasParaPostagem ?? 3,
    now: options.now ?? (() => new Date()),
  };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ erro: error.code, mensagem: error.message }, error.status);
    if (error instanceof ProviderFailure) {
      return c.json({ erro: "agregador_indisponivel", tipo: error.tipo, mensagem: error.message }, 502);
    }
    console.error(error);
    return c.json({ erro: "erro_interno", mensagem: "Erro inesperado." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/envios", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new RequestError(400, "corpo_invalido", "Envie um objeto JSON.");
    const result = await registerShipment(deps, body);
    return c.json(result.envio, result.criado ? 201 : 200);
  });

  app.get("/envios/:id", (c) => c.json(shipmentView(deps, c.req.param("id"))));

  app.post("/envios/:id/consultar", async (c) => {
    const result = await refreshShipment(deps, c.req.param("id"));
    return c.json({ consulta: result, envio: shipmentView(deps, c.req.param("id")) });
  });

  // Verificação de atrasos (agendada em produção; aqui por endpoint, com o relógio injetável).
  app.post("/verificacoes", async (c) => c.json(await runCheck(deps)));

  app.get("/avisos", (c) => c.json(listNotices(deps, { tipo: c.req.query("tipo"), envio: c.req.query("envio") })));
  app.get("/codigos-pendentes", (c) => c.json(pendingCodes(deps)));

  return app;
}
