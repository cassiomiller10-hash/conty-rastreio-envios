import { describe, expect, it } from "vitest";
import { recordEvents } from "../src/envios.ts";
import { CARRIERS, NATIONAL_HOLIDAYS_2026 } from "../src/transportadoras.ts";
import { add, CP, setup } from "./helpers.ts";

const CODE = "QB123456789BR";
type Notice = { tipo: string; envio: string | null; detalhes: Record<string, unknown> };

describe("avisos de exceção", () => {
  it("cada nova exceção, enquanto é o status atual, gera o seu próprio aviso", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-05T14:12:00", CP.postado);
    add(api, CODE, "2026-10-07T13:00:00", CP.ausente);
    await api.consult(envio);
    api.checkpoint(CODE, "2026-10-09T10:00:00", "EXT-01", "Objeto extraviado", "Campinas/SP", "Exception");
    await api.consult(envio);
    await api.consult(envio);
    const notices = (await api.notices("excecao")).body as Notice[];
    expect(notices.map((notice) => notice.detalhes.codigo_bruto)).toEqual(["BDE-20", "EXT-01"]);
  });

  it("exceção já resolvida quando ficamos sabendo não gera aviso (só a entrega gera)", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-05T14:12:00", CP.postado);
    add(api, CODE, "2026-10-07T13:00:00", CP.ausente);
    add(api, CODE, "2026-10-08T09:00:00", CP.saiu);
    add(api, CODE, "2026-10-08T11:00:00", CP.entregue);
    await api.consult(envio); // tudo de uma vez, depois da entrega
    expect(((await api.notices()).body as Notice[]).map((notice) => notice.tipo)).toEqual(["entregue"]);
  });

  it("o aviso de entrega sai uma vez só", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-08T11:00:00", CP.entregue);
    await api.consult(envio);
    await api.consult(envio);
    await api.check();
    expect((await api.notices("entregue")).body).toHaveLength(1);
  });
});

describe("avisos de código não reconhecido", () => {
  it("um aviso por código da transportadora, não um por pacote", async () => {
    const api = setup();
    for (const code of ["QB000000001BR", "QB000000002BR", "QB000000003BR"]) {
      const envio = await api.register(code);
      api.checkpoint(code, "2026-10-06T08:00:00", "XZ-77", "Objeto aguardando conferência especial", "Campinas/SP", "Delivered");
      await api.consult(envio);
    }
    const notices = (await api.notices("codigo_nao_reconhecido")).body as Notice[];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detalhes).toMatchObject({ transportadora: "correios", codigo_bruto: "XZ-77" });
    expect((await api.get("/codigos-pendentes")).body).toEqual([
      expect.objectContaining({ codigo_bruto: "XZ-77", traduzido_por: "nenhum", envios_afetados: 3 }),
    ]);
  });
});

describe("identidade normalizada do evento", () => {
  it("o mesmo fato escrito por outro agregador (local, segundos, fuso) não duplica nem repete aviso", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-05T14:12:00", CP.postado);
    api.checkpoint(CODE, "2026-10-07T13:00:00", "BDE-20", "Destinatário ausente - nova tentativa", "Campinas/SP", "AttemptFail");
    await api.consult(envio);

    // Outro agregador, mesmo fato: local escrito de outro jeito, hora com fuso, sem segundos, id próprio.
    const fromOtherAggregator = {
      previsaoEntrega: null,
      eventos: [
        { codigoBruto: "po-01", descricao: "OBJETO POSTADO", data: "2026-10-05T17:12Z", local: "SAO PAULO - SP", idAgregador: "x-1", sugestao: null, categoriaAgregador: null },
        { codigoBruto: "BDE-20", descricao: "Destinatario ausente", data: "2026-10-07T13:00:59-03:00", local: "campinas, sp", idAgregador: "x-2", sugestao: null, categoriaAgregador: null },
      ],
    };
    const imported = importInto(api, envio, fromOtherAggregator);
    expect(imported).toMatchObject({ eventos_recebidos: 2, eventos_novos: 0 });
    expect((await api.view(envio)).body.eventos).toHaveLength(2);
    expect((await api.notices("excecao")).body).toHaveLength(1);
  });
});

/** Entrada pela porta única de eventos, como faria um segundo agregador ou um webhook. */
function importInto(api: ReturnType<typeof setup>, envio: string, tracking: Parameters<typeof recordEvents>[2]) {
  return recordEvents(
    {
      db: api.db,
      provider: { nome: "outro", register: async () => {}, fetchTracking: async () => tracking },
      carriers: CARRIERS,
      holidays: new Set(NATIONAL_HOLIDAYS_2026),
      diasParaPostagem: 3,
      now: () => new Date("2026-10-08T12:00:00-03:00"),
    },
    envio,
    tracking,
    "2026-10-08T15:00:00.000Z",
  );
}
