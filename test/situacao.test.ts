import { describe, expect, it } from "vitest";
import { computeSituation, type StoredEvent } from "../src/situacao.ts";
import { CARRIERS, type Carrier } from "../src/transportadoras.ts";

// A regra é uma função pura do histórico: aqui ela é testada sem HTTP nem banco.

const correios = CARRIERS.correios as Carrier;

const event = (key: string, dataUtc: string, codigoBruto: string, extra: Partial<StoredEvent> = {}): StoredEvent => ({
  chave: key,
  dataUtc,
  dataOriginal: dataUtc,
  codigoBruto,
  descricao: codigoBruto,
  local: null,
  idAgregador: null,
  sugestao: null,
  categoriaAgregador: null,
  conhecidoEm: "2026-10-10T00:00:00.000Z",
  ...extra,
});

const HISTORY = [
  event("a", "2026-10-05T17:12:00.000Z", "PO-01"),
  event("b", "2026-10-06T11:40:00.000Z", "RO-01"),
  event("c", "2026-10-07T12:05:00.000Z", "OEC-01"),
  event("d", "2026-10-07T16:00:00.000Z", "BDE-20"),
  event("e", "2026-10-07T16:00:00.000Z", "XZ-77", { sugestao: "entregue", categoriaAgregador: "Delivered" }),
  event("f", "2026-10-08T13:00:00.000Z", "OEC-01"),
];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const situation = (eventos: StoredEvent[]) =>
  computeSituation({ eventos, carrier: correios, modalidade: "PAC", previsaoInicial: null, agora: "2026-10-09T12:00:00.000Z", feriados: new Set(["2026-10-12"]) });

describe("o resultado não depende da ordem de chegada", () => {
  it("as 720 ordens possíveis de 6 eventos dão exatamente a mesma situação", () => {
    const expected = situation(HISTORY);
    expect(expected).toMatchObject({ status: "saiu_para_entrega", statusDesde: "2026-10-08T13:00:00.000Z" });
    const all = permutations(HISTORY);
    expect(all).toHaveLength(720);
    for (const order of all) expect(situation(order)).toEqual(expected);
  });

  it("repetir eventos não muda nada", () => {
    expect(situation([...HISTORY, ...HISTORY])).toMatchObject({ status: situation(HISTORY).status, postadoEm: situation(HISTORY).postadoEm });
  });
});

describe("regras puras", () => {
  it("dois eventos de entrega: vale o primeiro; outro 'entregue' depois não pede revisão", () => {
    const result = situation([event("a", "2026-10-05T17:12:00.000Z", "PO-01"), event("b", "2026-10-07T14:00:00.000Z", "BDE-01"), event("c", "2026-10-07T18:00:00.000Z", "BDE-01")]);
    expect(result).toMatchObject({ status: "entregue", entregueEm: "2026-10-07T14:00:00.000Z", motivosRevisao: [] });
  });

  it("empate de horário entre mesma etapa: decide a identidade do evento, sempre igual", () => {
    const one = situation([event("z", "2026-10-07T12:00:00.000Z", "RO-01", { local: "Z" }), event("y", "2026-10-07T12:00:00.000Z", "DO-01", { local: "Y" })]);
    expect(one.eventoAtual?.chave).toBe("y");
  });

  it("sem eventos: sem status, com o motivo, e o prazo não corre", () => {
    expect(situation([])).toMatchObject({
      status: null,
      motivoSemStatus: "aguardando primeiro evento reconhecido",
      semEventoRelevante: true,
      prazo: { dias_uteis_em_transito: null, atrasado: false },
    });
  });

  it("previsão inicial anterior à postagem é ignorada (vale a tabela)", () => {
    const result = computeSituation({
      eventos: [event("a", "2026-10-05T17:12:00.000Z", "PO-01")],
      carrier: correios,
      modalidade: "SEDEX",
      previsaoInicial: "2026-10-03",
      agora: "2026-10-06T12:00:00.000Z",
      feriados: new Set(),
    });
    expect(result.prazo).toMatchObject({ limite_dias_uteis: 3, fonte_limite: "tabela (correios SEDEX)" });
  });

  it("modalidade sem limite próprio usa o padrão da transportadora", () => {
    const result = computeSituation({ eventos: [], carrier: correios, modalidade: "MINI ENVIOS", previsaoInicial: null, agora: "2026-10-06T12:00:00.000Z", feriados: new Set() });
    expect(result.prazo).toMatchObject({ limite_dias_uteis: 7, fonte_limite: "tabela (correios MINI ENVIOS, padrão da transportadora)" });
  });
});
