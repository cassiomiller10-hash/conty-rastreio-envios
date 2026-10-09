import { describe, expect, it } from "vitest";
import { add, CP, setup } from "./helpers.ts";

const CODE = "QB123456789BR";

async function withCheckpoints(checkpoints: Array<[string, readonly [string, string, string, string]]>) {
  const api = setup();
  const envio = await api.register(CODE);
  for (const [time, cp] of checkpoints) add(api, CODE, time, cp);
  return { api, envio };
}

describe("histórico sem duplicar", () => {
  it("consultar o mesmo código duas vezes não duplica o histórico", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-06T08:40:00", CP.transito],
    ]);
    const first = await api.consult(envio);
    const second = await api.consult(envio);
    expect(first.body.consulta).toMatchObject({ eventos_recebidos: 2, eventos_novos: 2 });
    expect(second.body.consulta).toMatchObject({ eventos_recebidos: 2, eventos_novos: 0 });
    expect(second.body.envio.eventos).toHaveLength(2);
  });

  it("o mesmo evento com ids diferentes do agregador conta uma vez só", async () => {
    const { api, envio } = await withCheckpoints([["2026-10-05T14:12:00", CP.postado]]);
    api.aggregator.unstableIds = true;
    await api.consult(envio);
    await api.consult(envio);
    const { body } = await api.view(envio);
    expect(body.eventos).toHaveLength(1);
  });

  it("cadastrar o mesmo código de novo devolve o envio existente", async () => {
    const api = setup();
    const first = await api.register(CODE);
    const again = await api.post("/envios", { campanha_id: "camp_verao26", criador_id: "cri_ana", transportadora: "correios", modalidade: "PAC", codigo: CODE.toLowerCase() });
    expect([again.status, again.body.envio]).toEqual([200, first]);
    const other = await api.post("/envios", { campanha_id: "camp_outra", criador_id: "cri_ana", transportadora: "correios", modalidade: "PAC", codigo: CODE });
    expect([other.status, other.body.erro]).toEqual([409, "codigo_de_outro_envio"]);
  });
});

describe("ordem dos eventos", () => {
  it("um evento antigo chegando depois não muda o status", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-07T09:05:00", CP.saiu],
    ]);
    await api.consult(envio);
    add(api, CODE, "2026-10-06T08:40:00", CP.transito); // aconteceu antes, chegou depois
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "saiu_para_entrega", status_desde: "2026-10-07T09:05:00-03:00" });
    expect(body.envio.eventos.map((event: { codigo_bruto: string }) => event.codigo_bruto)).toEqual(["PO-01", "RO-01", "OEC-01"]);
  });

  it("eventos embaralhados dão o mesmo resultado que em ordem", async () => {
    const checkpoints: Array<[string, readonly [string, string, string, string]]> = [
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-06T08:40:00", CP.transito],
      ["2026-10-07T09:05:00", CP.saiu],
      ["2026-10-07T13:00:00", CP.ausente],
      ["2026-10-08T10:00:00", CP.saiu],
    ];
    const ordered = await withCheckpoints(checkpoints);
    await ordered.api.consult(ordered.envio);
    const shuffled = await withCheckpoints([...checkpoints].reverse());
    shuffled.api.aggregator.shuffle = true;
    await shuffled.api.consult(shuffled.envio);
    await shuffled.api.consult(shuffled.envio);
    const strip = (view: Record<string, unknown>) => {
      const { envio: _id, eventos, cadastrado_em: _c, ultima_consulta_em: _u, ...rest } = view as { envio: string; eventos: Array<Record<string, unknown>>; cadastrado_em: string; ultima_consulta_em: string };
      return { ...rest, eventos: eventos.map(({ id_agregador: _a, conhecido_em: _k, ...event }) => event) };
    };
    expect(strip((await shuffled.api.view(shuffled.envio)).body)).toEqual(strip((await ordered.api.view(ordered.envio)).body));
  });

  it("saiu para entrega seguido de em trânsito mais recente volta para em trânsito", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-07T09:05:00", CP.saiu],
      ["2026-10-07T18:30:00", CP.transito],
    ]);
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "em_transito", status_desde: "2026-10-07T18:30:00-03:00" });
  });

  it("um evento depois de entregue não tira o pacote de entregue e marca revisão", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-07T11:30:00", CP.entregue],
      ["2026-10-08T08:00:00", CP.transito],
    ]);
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({
      status: "entregue",
      entregue_em: "2026-10-07T11:30:00-03:00",
      precisa_revisao: true,
      motivos_revisao: ["evento depois da entrega: RO-01 em 2026-10-08T08:00:00-03:00"],
    });
  });

  it("no empate de horário vence a etapa mais informativa", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-05T14:12:00", CP.postado],
      ["2026-10-07T09:05:00", CP.saiu],
      ["2026-10-07T09:05:00", CP.ausente],
    ]);
    expect((await api.consult(envio)).body.envio.status).toBe("excecao");
  });

  it("hora sem fuso usa o fuso da transportadora; hora com fuso é respeitada", async () => {
    const { api, envio } = await withCheckpoints([
      ["2026-10-07T09:05:00", CP.saiu],
      ["2026-10-07T13:00:00Z", CP.transito], // 10:00 em Brasília: mais recente que 09:05
    ]);
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "em_transito", status_desde: "2026-10-07T10:00:00-03:00" });
  });
});

describe("dialeto da transportadora", () => {
  it("o exemplo do desenho: código inventado que o agregador chama de 'Delivered' não vira entregue", async () => {
    const api = setup({ now: "2026-10-07T12:00:00-03:00" });
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-05T14:12:00", CP.postado);
    add(api, CODE, "2026-10-06T08:40:00", CP.transito);
    add(api, CODE, "2026-10-07T09:05:00", CP.saiu);
    api.checkpoint(CODE, "2026-10-07T11:30:00", "XZ-77", "Objeto aguardando conferência especial", "Campinas/SP", "Delivered");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({
      status: "saiu_para_entrega",
      status_desde: "2026-10-07T09:05:00-03:00",
      precisa_revisao: true,
      postado_em: "2026-10-05T14:12:00-03:00",
      entregue_em: null,
      prazo: { limite_dias_uteis: 7, dias_uteis_em_transito: 2, atrasado: false },
    });
    expect(body.envio.eventos.at(-1)).toMatchObject({
      codigo_bruto: "XZ-77",
      status: null,
      traduzido_por: "nenhum",
      motivo: "código fora da tabela; a categoria 'Delivered' do agregador não é aceita para entregue (só a tabela define status que mexem em prazo)",
    });
  });

  it("código inventado sem categoria não muda o status e marca revisão", async () => {
    const { api, envio } = await withCheckpoints([["2026-10-06T08:40:00", CP.transito]]);
    api.checkpoint(CODE, "2026-10-06T20:00:00", "ZZ-99", "Objeto em análise", "Cajamar/SP", null);
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "em_transito", precisa_revisao: true, motivos_revisao: ["código não reconhecido: ZZ-99 (Objeto em análise)"] });
  });

  it("código fora da tabela com categoria de trânsito é aceito e fica marcado para entrar na tabela", async () => {
    const { api, envio } = await withCheckpoints([["2026-10-05T14:12:00", CP.postado]]);
    api.checkpoint(CODE, "2026-10-06T09:00:00", "TR-55", "Objeto em transferência entre unidades", "Jundiaí/SP", "InTransit");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "em_transito", precisa_revisao: false });
    expect(body.envio.eventos.at(-1)).toMatchObject({ traduzido_por: "agregador" });
    expect((await api.get("/codigos-pendentes")).body).toEqual([
      expect.objectContaining({ codigo_bruto: "TR-55", traduzido_por: "agregador", status_pela_categoria: "em_transito", envios_afetados: 1 }),
    ]);
  });

  it("pacote cujo primeiro evento é desconhecido fica sem status, com o motivo", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    api.checkpoint(CODE, "2026-10-05T14:12:00", "NOVO-1", "Objeto recebido na agência", "São Paulo/SP", null);
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: null, motivo_sem_status: "aguardando primeiro evento reconhecido", postado_em: null, precisa_revisao: true });
  });

  it("'postado' só sai da tabela: etiqueta emitida (InfoReceived fora da tabela) não liga o relógio", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    api.checkpoint(CODE, "2026-10-05T10:00:00", "LBL-9", "Etiqueta gerada pelo remetente", "São Paulo/SP", "InfoReceived");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: null, postado_em: null });
    expect(body.envio.eventos[0].motivo).toContain("não é aceita para postado");
  });

  it("código conhecido que não é status (etiqueta emitida) não muda nada e não vai para revisão", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    api.checkpoint(CODE, "2026-10-05T10:00:00", "ETQ-01", "Etiqueta emitida, aguardando postagem", "São Paulo/SP", "InfoReceived");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: null, precisa_revisao: false, postado_em: null });
    expect(body.envio.eventos[0]).toMatchObject({ traduzido_por: "tabela", status: null, motivo: "código conhecido que não muda o status" });
  });

  it("'entregue ao remetente' (devolução com o mesmo código) é exceção, não entrega", async () => {
    const { api, envio } = await withCheckpoints([["2026-10-05T14:12:00", CP.postado]]);
    api.checkpoint(CODE, "2026-10-20T15:00:00", "BDR-01", "Objeto devolvido e entregue ao remetente", "São Paulo/SP", "Delivered");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ status: "excecao", entregue_em: null });
  });

  it("entregue_em é a data da transportadora, não a data em que soubemos", async () => {
    const api = setup();
    const envio = await api.register(CODE);
    add(api, CODE, "2026-10-05T14:12:00", CP.postado);
    add(api, CODE, "2026-10-07T11:30:00", CP.entregue);
    api.setNow("2026-10-10T16:00:00-03:00");
    const { body } = await api.consult(envio);
    expect(body.envio).toMatchObject({ entregue_em: "2026-10-07T11:30:00-03:00" });
    expect(body.envio.eventos[1].conhecido_em).toBe("2026-10-10T16:00:00-03:00");
  });
});
