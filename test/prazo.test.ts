import { describe, expect, it } from "vitest";
import { CARRIERS } from "../src/transportadoras.ts";
import { add, CP, setup } from "./helpers.ts";

// Calendário de outubro de 2026: 01/10 é quinta; 10 e 11 são fim de semana; 12/10 é feriado.
// Correios PAC: limite de 7 dias úteis, contados a partir do dia útil seguinte à postagem.
const CODE = "QB123456789BR";

async function postedOnOct1() {
  const api = setup({ now: "2026-10-01T08:00:00-03:00" });
  const envio = await api.register(CODE);
  add(api, CODE, "2026-10-01T14:00:00", CP.postado);
  add(api, CODE, "2026-10-02T09:00:00", CP.transito);
  return { api, envio };
}

describe("atraso em dias úteis", () => {
  it("dentro do limite não avisa, atravessando fim de semana e feriado (terça 13/10 = 7º dia útil)", async () => {
    const { api, envio } = await postedOnOct1();
    api.setNow("2026-10-13T18:00:00-03:00");
    const check = await api.check();
    expect(check.body.avisos_emitidos).toEqual([]);
    expect((await api.view(envio)).body.prazo).toEqual({
      limite_dias_uteis: 7,
      fonte_limite: "tabela (correios PAC)",
      dias_uteis_em_transito: 7,
      atrasado: false,
    });
  });

  it("acima do limite gera um aviso, e só um, mesmo verificando várias vezes", async () => {
    const { api, envio } = await postedOnOct1();
    api.setNow("2026-10-14T09:00:00-03:00");
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "atraso" }]);
    await api.check();
    api.setNow("2026-10-15T09:00:00-03:00");
    await api.check();
    const notices = (await api.notices("atraso")).body;
    expect(notices).toHaveLength(1);
    expect(notices[0].detalhes).toMatchObject({ dias_uteis_em_transito: 8, limite_dias_uteis: 7, postado_em: "2026-10-01T14:00:00-03:00" });
  });

  it("entregue dentro do prazo, mas descoberto depois, não é atraso", async () => {
    const { api, envio } = await postedOnOct1();
    add(api, CODE, "2026-10-09T11:00:00", CP.entregue); // 6º dia útil
    api.setNow("2026-10-16T10:00:00-03:00"); // só consultamos dias depois do limite
    const check = await api.check();
    expect(check.body.avisos_emitidos).toEqual([{ envio, tipo: "entregue" }]);
    expect((await api.view(envio)).body.prazo).toMatchObject({ dias_uteis_em_transito: 6, atrasado: false });
  });

  it("a consulta nova antes do aviso evita alarme falso quando o pacote já foi entregue", async () => {
    const { api, envio } = await postedOnOct1();
    await api.consult(envio); // o que sabíamos em 01/10: postado e em trânsito
    add(api, CODE, "2026-10-13T16:00:00", CP.entregue); // entregue no 7º dia útil; ainda não sabíamos
    api.setNow("2026-10-14T09:00:00-03:00");
    const before = (await api.view(envio)).body.prazo;
    expect(before.atrasado).toBe(true); // com o histórico velho, pareceria atrasado
    const check = await api.check();
    expect(check.body.avisos_emitidos).toEqual([{ envio, tipo: "entregue" }]);
    expect((await api.notices("atraso")).body).toEqual([]);
  });

  it("cadastrado e nunca postado gera 'ainda não postado', e não atraso", async () => {
    const api = setup({ now: "2026-10-01T08:00:00-03:00" });
    const envio = await api.register(CODE);
    api.checkpoint(CODE, "2026-10-01T10:00:00", "ETQ-01", "Etiqueta emitida, aguardando postagem", "São Paulo/SP", "InfoReceived");
    api.setNow("2026-10-06T10:00:00-03:00"); // 3º dia útil depois do cadastro: ainda no prazo
    expect((await api.check()).body.avisos_emitidos).toEqual([]);
    api.setNow("2026-10-07T10:00:00-03:00"); // 4º dia útil
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "ainda_nao_postado" }]);
    await api.check();
    expect((await api.notices()).body.map((notice: { tipo: string }) => notice.tipo)).toEqual(["ainda_nao_postado"]);
  });

  it("etiqueta emitida na segunda e despacho na sexta: o relógio liga no despacho, sem alarme falso", async () => {
    const api = setup({ now: "2026-10-05T08:00:00-03:00" });
    const envio = await api.register(CODE, { modalidade: "SEDEX" }); // limite 3 dias úteis
    api.checkpoint(CODE, "2026-10-05T10:00:00", "LBL-9", "Etiqueta gerada pelo remetente", "São Paulo/SP", "InfoReceived");
    add(api, CODE, "2026-10-09T15:00:00", CP.postado);
    api.setNow("2026-10-09T18:00:00-03:00");
    // O código LBL-9 é novo: gera o aviso de código não reconhecido, mas não de atraso.
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "codigo_nao_reconhecido" }]);
    expect((await api.view(envio)).body).toMatchObject({ postado_em: "2026-10-09T15:00:00-03:00", prazo: { dias_uteis_em_transito: 0, atrasado: false } });
  });
});

describe("primeira previsão da transportadora", () => {
  it("rota longa: com a previsão (20/10), o 8º dia útil não é atraso; passou da previsão, é", async () => {
    const { api, envio } = await postedOnOct1();
    api.aggregator.setExpectedDelivery("correios", CODE, "2026-10-20");
    api.setNow("2026-10-14T09:00:00-03:00");
    expect((await api.check()).body.avisos_emitidos).toEqual([]);
    expect((await api.view(envio)).body.prazo).toEqual({
      limite_dias_uteis: 12,
      fonte_limite: "primeira previsão da transportadora (2026-10-20)",
      dias_uteis_em_transito: 8,
      atrasado: false,
    });
    api.setNow("2026-10-21T09:00:00-03:00");
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "atraso" }]);
  });

  it("previsão reajustada para frente não adia o atraso: vale a primeira", async () => {
    const { api, envio } = await postedOnOct1();
    api.aggregator.setExpectedDelivery("correios", CODE, "2026-10-20");
    await api.consult(envio);
    api.aggregator.setExpectedDelivery("correios", CODE, "2026-10-27");
    api.setNow("2026-10-21T09:00:00-03:00");
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "atraso" }]);
    expect((await api.view(envio)).body.previsao_entrega).toEqual({ inicial: "2026-10-20", atual: "2026-10-27" });
  });

  it("rota curta: com previsão de 05/10, parado em 07/10 já é atraso, mesmo abaixo do limite da tabela", async () => {
    const { api, envio } = await postedOnOct1();
    api.aggregator.setExpectedDelivery("correios", CODE, "2026-10-05");
    api.setNow("2026-10-07T09:00:00-03:00");
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "atraso" }]);
  });
});

describe("verificação consulta tudo e não avisa sem confirmar", () => {
  it("agregador fora do ar na verificação: sem aviso, fica 'não confirmado' e avisa na próxima", async () => {
    const { api, envio } = await postedOnOct1();
    await api.consult(envio); // o histórico guardado já mostra postado em 01/10
    api.setNow("2026-10-14T09:00:00-03:00");
    expect((await api.view(envio)).body.prazo.atrasado).toBe(true); // com o histórico velho, parece atrasado
    api.aggregator.failNext({ status: 503 });
    const failed = await api.check();
    expect(failed.body.avisos_emitidos).toEqual([]);
    expect(failed.body.nao_confirmados).toEqual([{ envio, erro: "o agregador respondeu 503 à consulta" }]);
    expect((await api.notices()).body).toEqual([]);
    expect((await api.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "atraso" }]);
  });

  it("verificação consulta envios em aberto mesmo sem atraso, e o aviso de entrega sai na hora", async () => {
    const { api, envio } = await postedOnOct1();
    add(api, CODE, "2026-10-05T11:00:00", CP.entregue);
    api.setNow("2026-10-05T18:00:00-03:00");
    expect((await api.check()).body).toMatchObject({ consultados: 1, avisos_emitidos: [{ envio, tipo: "entregue" }] });
  });

  it("mudança na tabela que torna um pacote entregue gera o aviso de entrega na verificação", async () => {
    const before = setup({ now: "2026-10-01T08:00:00-03:00" });
    const envio = await before.register(CODE);
    add(before, CODE, "2026-10-01T14:00:00", CP.postado);
    before.checkpoint(CODE, "2026-10-06T10:00:00", "BDE-77", "Entregue na portaria", "Campinas/SP", "Delivered");
    await before.consult(envio);
    expect((await before.view(envio)).body.status).toBe("postado");

    // A Conty confere o código e inclui na tabela: mesmo banco, tabela nova.
    const correios = CARRIERS.correios as (typeof CARRIERS)[string];
    const carriers = {
      ...CARRIERS,
      correios: { ...correios, codigos: { ...correios.codigos, "BDE-77": { traducao: "entregue" as const, descricao: "Entregue na portaria" } } },
    };
    const after = setup({ now: "2026-10-08T09:00:00-03:00", db: before.db, aggregator: before.aggregator, carriers });
    expect((await after.view(envio)).body).toMatchObject({ status: "entregue", entregue_em: "2026-10-06T10:00:00-03:00" });
    expect((await after.check()).body.avisos_emitidos).toEqual([{ envio, tipo: "entregue" }]);
  });
});
