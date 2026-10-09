import { describe, expect, it } from "vitest";
import { ProviderFailure } from "../src/agregador/provedor.ts";
import { createFakeTrackingClient } from "../src/agregador/rastreio-falso.ts";
import { FakeAggregator } from "../src/simulador/agregador-falso.ts";
import { API_KEY, setup } from "./helpers.ts";

const CODE = "QB123456789BR";

function client(aggregator: FakeAggregator, timeoutMs = 2_000, apiKey = API_KEY) {
  return createFakeTrackingClient({
    baseUrl: "http://agregador.test",
    apiKey,
    timeoutMs,
    fetchFn: (input, init) => Promise.resolve(aggregator.app.request(input, init)),
  });
}

describe("cliente HTTP do agregador", () => {
  it("traduz o formato do agregador para o evento padronizado", async () => {
    const aggregator = new FakeAggregator(API_KEY);
    const provider = client(aggregator);
    await provider.register({ transportadora: "correios", modalidade: "PAC", codigo: CODE });
    aggregator.addCheckpoint("correios", CODE, { id: "cp_91a", checkpoint_time: "2026-10-05T14:12:00", raw_status: "PO-01", message: "Objeto postado", location: "São Paulo/SP", tag: "InfoReceived" });
    aggregator.setExpectedDelivery("correios", CODE, "2026-10-14");
    expect(await provider.fetchTracking({ transportadora: "correios", codigo: CODE })).toEqual({
      previsaoEntrega: "2026-10-14",
      eventos: [
        { codigoBruto: "PO-01", descricao: "Objeto postado", data: "2026-10-05T14:12:00", local: "São Paulo/SP", idAgregador: "cp_91a", sugestao: "postado", categoriaAgregador: "InfoReceived" },
      ],
    });
  });

  it("cadastrar de novo no agregador (409 lá) não é erro", async () => {
    const aggregator = new FakeAggregator(API_KEY);
    const provider = client(aggregator);
    await provider.register({ transportadora: "correios", modalidade: "PAC", codigo: CODE });
    await expect(provider.register({ transportadora: "correios", modalidade: "PAC", codigo: CODE })).resolves.toBeUndefined();
  });

  it("agregador que não responde: falha com tempo esgotado, sem ficar pendurado", async () => {
    const aggregator = new FakeAggregator(API_KEY);
    const provider = client(aggregator, 50);
    await provider.register({ transportadora: "correios", modalidade: "PAC", codigo: CODE });
    aggregator.failNext({ hang: true });
    const started = Date.now();
    const error = await provider.fetchTracking({ transportadora: "correios", codigo: CODE }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderFailure);
    expect(error).toMatchObject({ tipo: "tempo_esgotado", message: "o agregador não respondeu em 50 ms" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ["erro do agregador", { status: 500 }, "http", "o agregador respondeu 500 à consulta"],
    ["código que o agregador não conhece", null, "http", "o agregador respondeu 404 à consulta"],
  ] as const)("%s vira falha clara", async (_, failure, tipo, message) => {
    const aggregator = new FakeAggregator(API_KEY);
    const provider = client(aggregator);
    if (failure) {
      await provider.register({ transportadora: "correios", modalidade: "PAC", codigo: CODE });
      aggregator.failNext(failure);
    }
    await expect(provider.fetchTracking({ transportadora: "correios", codigo: CODE })).rejects.toMatchObject({ tipo, message });
  });

  it("chave de API errada vira falha HTTP", async () => {
    const aggregator = new FakeAggregator(API_KEY);
    await expect(client(aggregator, 2_000, "chave-errada").register({ transportadora: "correios", modalidade: "PAC", codigo: CODE })).rejects.toMatchObject({
      tipo: "http",
      message: "o agregador respondeu 401 ao cadastrar",
    });
  });

  it("resposta fora do formato vira falha de formato", async () => {
    const provider = createFakeTrackingClient({
      baseUrl: "http://agregador.test",
      apiKey: API_KEY,
      fetchFn: async () => new Response(JSON.stringify({ checkpoints: [{ checkpoint_time: 123 }] }), { status: 200 }),
    });
    await expect(provider.fetchTracking({ transportadora: "correios", codigo: CODE })).rejects.toMatchObject({ tipo: "formato" });
  });
});

describe("API com o agregador falhando", () => {
  it("cadastro com o agregador fora do ar responde 502 e não grava nada", async () => {
    const api = setup();
    api.aggregator.failNext({ status: 503 });
    const res = await api.post("/envios", { campanha_id: "c", criador_id: "a", transportadora: "correios", modalidade: "PAC", codigo: CODE });
    expect([res.status, res.body.erro]).toEqual([502, "agregador_indisponivel"]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM envios").get()).toEqual({ n: 0 });
  });

  it("consulta com tempo esgotado responde 502 e não muda o histórico", async () => {
    const api = setup({ timeoutMs: 50 });
    const envio = await api.register(CODE);
    api.aggregator.failNext({ hang: true });
    const res = await api.consult(envio);
    expect([res.status, res.body.tipo]).toEqual([502, "tempo_esgotado"]);
    expect((await api.view(envio)).body.eventos).toEqual([]);
  });

  it("transportadora sem tabela de códigos é recusada", async () => {
    const api = setup();
    const res = await api.post("/envios", { campanha_id: "c", criador_id: "a", transportadora: "loggi", modalidade: "X", codigo: "LG1" });
    expect([res.status, res.body.erro]).toEqual([400, "transportadora_sem_tabela"]);
  });
});
