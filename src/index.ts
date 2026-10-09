import { serve } from "@hono/node-server";
import { createFakeTrackingClient } from "./agregador/rastreio-falso.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { FakeAggregator } from "./simulador/agregador-falso.ts";

// Demonstração: sobe o agregador falso (porta 4007) e a API (porta 3007), que fala com ele por HTTP
// de verdade, como falaria com um agregador real.
const apiKey = process.env.AGREGADOR_API_KEY ?? "chave-de-demonstracao";
const aggregatorPort = Number(process.env.AGREGADOR_PORT ?? 4007);
const port = Number(process.env.PORT ?? 3007);

const aggregator = new FakeAggregator(apiKey);
serve({ fetch: aggregator.app.fetch, port: aggregatorPort }, (info) => {
  console.log(`agregador falso em http://127.0.0.1:${info.port}`);
});

const provider = createFakeTrackingClient({ baseUrl: process.env.AGREGADOR_URL ?? `http://127.0.0.1:${aggregatorPort}`, apiKey, timeoutMs: 5_000 });
const db = openDatabase(process.env.DB_PATH ?? "data/rastreio.sqlite");
serve({ fetch: createApp(db, provider).fetch, port }, (info) => {
  console.log(`rastreio de envios em http://127.0.0.1:${info.port}`);
});
