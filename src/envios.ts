import type { DatabaseSync } from "node:sqlite";
import type { StandardTracking, TrackingProvider } from "./agregador/provedor.ts";
import { transaction } from "./db.ts";
import { computeSituation, type Situation, type StoredEvent } from "./situacao.ts";
import type { Status } from "./status.ts";
import { businessDaysBetween, inZone, localDate, toInstant } from "./tempo.ts";
import { type Carrier, normalizeRawCode } from "./transportadoras.ts";

export class RequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Deps = {
  db: DatabaseSync;
  provider: TrackingProvider;
  carriers: Record<string, Carrier>;
  holidays: ReadonlySet<string>;
  /** Dias úteis depois do cadastro sem nenhum evento para avisar "ainda não postado". */
  diasParaPostagem: number;
  now: () => Date;
};

type ShipmentRow = {
  id: string;
  campanha_id: string;
  criador_id: string;
  transportadora: string;
  modalidade: string;
  codigo: string;
  cadastrado_em: string;
  ultima_consulta_em: string | null;
  previsao_inicial: string | null;
  previsao_atual: string | null;
};

type EventRow = {
  chave: string;
  data_utc: string;
  data_original: string;
  codigo_bruto: string;
  descricao: string;
  local: string | null;
  id_agregador: string | null;
  sugestao: Status | null;
  categoria_agregador: string | null;
  conhecido_em: string;
};

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** "Cajamar/SP", "CAJAMAR - SP" e "Cajamar, SP" são o mesmo lugar. */
export function normalizeLocation(location: string | null): string {
  return (location ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Identidade do fato: transportadora, código de rastreio, instante (até o minuto, em UTC), código bruto e local. */
export function eventKey(shipment: Pick<ShipmentRow, "transportadora" | "codigo">, instantUtc: string, rawCode: string, location: string | null): string {
  return [shipment.transportadora, shipment.codigo, instantUtc.slice(0, 16), normalizeRawCode(rawCode), normalizeLocation(location)].join("|");
}

function shipmentOrThrow(deps: Deps, id: string): ShipmentRow {
  const row = deps.db.prepare("SELECT * FROM envios WHERE id = ?").get(id) as ShipmentRow | undefined;
  if (!row) throw new RequestError(404, "envio_nao_encontrado", "Envio não encontrado.");
  return row;
}

function situationOf(deps: Deps, shipment: ShipmentRow): Situation {
  const rows = deps.db.prepare("SELECT * FROM eventos WHERE envio_id = ?").all(shipment.id) as EventRow[];
  const eventos: StoredEvent[] = rows.map((row) => ({
    chave: row.chave,
    dataUtc: row.data_utc,
    dataOriginal: row.data_original,
    codigoBruto: row.codigo_bruto,
    descricao: row.descricao,
    local: row.local,
    idAgregador: row.id_agregador,
    sugestao: row.sugestao,
    categoriaAgregador: row.categoria_agregador,
    conhecidoEm: row.conhecido_em,
  }));
  return computeSituation({
    eventos,
    carrier: deps.carriers[shipment.transportadora] as Carrier,
    modalidade: shipment.modalidade,
    previsaoInicial: shipment.previsao_inicial,
    agora: deps.now().toISOString(),
    feriados: deps.holidays,
  });
}

function emitNotice(deps: Deps, notice: { tipo: string; envioId: string | null; chave: string; detalhes: Record<string, unknown> }): boolean {
  const result = deps.db
    .prepare("INSERT OR IGNORE INTO avisos (tipo, envio_id, chave, criado_em, detalhes_json) VALUES (?, ?, ?, ?, ?)")
    .run(notice.tipo, notice.envioId, notice.chave, deps.now().toISOString(), JSON.stringify(notice.detalhes));
  return result.changes > 0;
}

/**
 * Avisos que dependem só da situação atual: entrega (uma vez por envio), exceção (só se for o
 * status atual e o pacote não foi entregue: exceção já resolvida não avisa) e código não reconhecido
 * (uma vez por código da transportadora, não por pacote).
 */
function emitSituationNotices(deps: Deps, shipment: ShipmentRow, situation: Situation): string[] {
  const carrier = deps.carriers[shipment.transportadora] as Carrier;
  const emitted: string[] = [];
  if (situation.status === "entregue" && situation.entregueEm) {
    const ok = emitNotice(deps, {
      tipo: "entregue",
      envioId: shipment.id,
      chave: `entregue:${shipment.id}`,
      detalhes: { entregue_em: inZone(situation.entregueEm, carrier.fuso), campanha_id: shipment.campanha_id, criador_id: shipment.criador_id },
    });
    if (ok) emitted.push("entregue");
  }
  if (situation.status === "excecao" && situation.eventoAtual) {
    const event = situation.eventoAtual;
    const ok = emitNotice(deps, {
      tipo: "excecao",
      envioId: shipment.id,
      chave: `excecao:${event.chave}`,
      detalhes: { codigo_bruto: event.codigoBruto, descricao: event.descricao, data: inZone(event.dataUtc, carrier.fuso), local: event.local },
    });
    if (ok) emitted.push("excecao");
  }
  for (const unknown of situation.codigosNaoReconhecidos) {
    const ok = emitNotice(deps, {
      tipo: "codigo_nao_reconhecido",
      envioId: null,
      chave: `codigo:${shipment.transportadora}:${unknown.codigoBruto}`,
      detalhes: { transportadora: shipment.transportadora, codigo_bruto: unknown.codigoBruto, descricao: unknown.descricao, primeiro_envio: shipment.id },
    });
    if (ok) emitted.push("codigo_nao_reconhecido");
  }
  return emitted;
}

// ---------------------------------------------------------------------------------------------
// Porta única de entrada de eventos: consulta, webhook futuro ou importação passam por aqui.
// ---------------------------------------------------------------------------------------------

export function recordEvents(deps: Deps, shipmentId: string, tracking: StandardTracking, knownAt: string) {
  return transaction(deps.db, () => {
    const shipment = shipmentOrThrow(deps, shipmentId);
    const carrier = deps.carriers[shipment.transportadora] as Carrier;
    const insert = deps.db.prepare(
      `INSERT OR IGNORE INTO eventos (envio_id, chave, data_utc, data_original, codigo_bruto, descricao, local, id_agregador,
         sugestao, categoria_agregador, conhecido_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let novos = 0;
    const invalidos: string[] = [];
    for (const event of tracking.eventos) {
      const instant = toInstant(event.data, carrier.fuso);
      if (!instant) {
        invalidos.push(`${event.codigoBruto}: data ilegível '${event.data}'`);
        continue;
      }
      const result = insert.run(
        shipment.id,
        eventKey(shipment, instant, event.codigoBruto, event.local),
        instant,
        event.data,
        event.codigoBruto.trim(),
        event.descricao,
        event.local,
        event.idAgregador,
        event.sugestao,
        event.categoriaAgregador,
        knownAt,
      );
      novos += Number(result.changes);
    }
    // A primeira previsão nunca é sobrescrita: a transportadora reajusta a previsão para frente.
    deps.db
      .prepare("UPDATE envios SET ultima_consulta_em = ?, previsao_atual = COALESCE(?, previsao_atual), previsao_inicial = COALESCE(previsao_inicial, ?) WHERE id = ?")
      .run(knownAt, tracking.previsaoEntrega, tracking.previsaoEntrega, shipment.id);
    const updated = shipmentOrThrow(deps, shipment.id);
    const avisos = emitSituationNotices(deps, updated, situationOf(deps, updated));
    return { eventos_recebidos: tracking.eventos.length, eventos_novos: novos, eventos_invalidos: invalidos, avisos };
  });
}

// ---------------------------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------------------------

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function registerShipment(deps: Deps, body: Record<string, unknown>) {
  const campanhaId = text(body.campanha_id);
  const criadorId = text(body.criador_id);
  const transportadora = text(body.transportadora).toLowerCase();
  const modalidade = text(body.modalidade);
  const codigo = text(body.codigo).toUpperCase();
  if (!campanhaId || !criadorId || !modalidade || !codigo) {
    throw new RequestError(400, "dados_obrigatorios", "Informe campanha_id, criador_id, transportadora, modalidade e codigo.");
  }
  if (!deps.carriers[transportadora]) {
    throw new RequestError(400, "transportadora_sem_tabela", `Sem tabela de códigos para '${transportadora}'.`);
  }
  const existing = deps.db.prepare("SELECT * FROM envios WHERE transportadora = ? AND codigo = ?").get(transportadora, codigo) as
    | ShipmentRow
    | undefined;
  if (existing) {
    if (existing.campanha_id !== campanhaId || existing.criador_id !== criadorId) {
      throw new RequestError(409, "codigo_de_outro_envio", "Este código já está cadastrado para outra campanha ou outro criador.");
    }
    return { criado: false, envio: shipmentView(deps, existing.id) };
  }
  // Cadastra no agregador antes de gravar: se o agregador falhar, nada fica pela metade.
  await deps.provider.register({ transportadora, modalidade, codigo });
  const id = newId("env");
  deps.db
    .prepare("INSERT INTO envios (id, campanha_id, criador_id, transportadora, modalidade, codigo, cadastrado_em) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, campanhaId, criadorId, transportadora, modalidade, codigo, deps.now().toISOString());
  return { criado: true, envio: shipmentView(deps, id) };
}

export async function refreshShipment(deps: Deps, shipmentId: string) {
  const shipment = shipmentOrThrow(deps, shipmentId);
  const tracking = await deps.provider.fetchTracking({ transportadora: shipment.transportadora, codigo: shipment.codigo });
  return recordEvents(deps, shipmentId, tracking, deps.now().toISOString());
}

export function shipmentView(deps: Deps, shipmentId: string) {
  const shipment = shipmentOrThrow(deps, shipmentId);
  const carrier = deps.carriers[shipment.transportadora] as Carrier;
  const situation = situationOf(deps, shipment);
  const local = (instant: string | null) => (instant ? inZone(instant, carrier.fuso) : null);
  return {
    envio: shipment.id,
    campanha: shipment.campanha_id,
    criador: shipment.criador_id,
    transportadora: shipment.transportadora,
    modalidade: shipment.modalidade,
    codigo: shipment.codigo,
    status: situation.status,
    status_desde: local(situation.statusDesde),
    motivo_sem_status: situation.motivoSemStatus,
    precisa_revisao: situation.motivosRevisao.length > 0,
    motivos_revisao: situation.motivosRevisao,
    postado_em: local(situation.postadoEm),
    entregue_em: local(situation.entregueEm),
    prazo: situation.prazo,
    previsao_entrega: { inicial: shipment.previsao_inicial, atual: shipment.previsao_atual },
    cadastrado_em: local(shipment.cadastrado_em),
    ultima_consulta_em: local(shipment.ultima_consulta_em),
    eventos: situation.eventos.map((event) => ({
      data: inZone(event.dataUtc, carrier.fuso),
      codigo_bruto: event.codigoBruto,
      descricao: event.descricao,
      local: event.local,
      status: event.status,
      traduzido_por: event.traduzidoPor,
      ...(event.motivo ? { motivo: event.motivo } : {}),
      conhecido_em: local(event.conhecidoEm),
      id_agregador: event.idAgregador,
    })),
  };
}

/**
 * Verificação (rodar por agendamento): consulta de novo TODOS os envios em aberto e só então decide
 * os avisos de atraso e de "ainda não postado". Consulta que falha não gera aviso: fica como "não
 * confirmado" e é tentada de novo na próxima verificação. Envios já entregues não são consultados,
 * mas passam pela emissão de avisos (ex.: a tabela mudou e um pacote virou entregue).
 */
export async function runCheck(deps: Deps) {
  const shipments = deps.db.prepare("SELECT * FROM envios ORDER BY cadastrado_em, id").all() as ShipmentRow[];
  const summary = {
    verificados: 0,
    consultados: 0,
    nao_confirmados: [] as Array<{ envio: string; erro: string }>,
    avisos_emitidos: [] as Array<{ envio: string; tipo: string }>,
  };
  for (const shipment of shipments) {
    summary.verificados += 1;
    const carrier = deps.carriers[shipment.transportadora] as Carrier;
    let situation = situationOf(deps, shipment);
    if (situation.status !== "entregue") {
      try {
        const result = await refreshShipment(deps, shipment.id);
        summary.consultados += 1;
        for (const tipo of result.avisos) summary.avisos_emitidos.push({ envio: shipment.id, tipo });
      } catch (error) {
        summary.nao_confirmados.push({ envio: shipment.id, erro: error instanceof Error ? error.message : String(error) });
        continue;
      }
      situation = situationOf(deps, shipmentOrThrow(deps, shipment.id));
    }
    for (const tipo of emitSituationNotices(deps, shipment, situation)) summary.avisos_emitidos.push({ envio: shipment.id, tipo });
    if (situation.status === "entregue") continue;

    if (situation.prazo.atrasado) {
      const ok = emitNotice(deps, {
        tipo: "atraso",
        envioId: shipment.id,
        chave: `atraso:${shipment.id}`,
        detalhes: {
          postado_em: situation.postadoEm ? inZone(situation.postadoEm, carrier.fuso) : null,
          dias_uteis_em_transito: situation.prazo.dias_uteis_em_transito,
          limite_dias_uteis: situation.prazo.limite_dias_uteis,
          fonte_limite: situation.prazo.fonte_limite,
          status: situation.status,
        },
      });
      if (ok) summary.avisos_emitidos.push({ envio: shipment.id, tipo: "atraso" });
    } else if (situation.semEventoRelevante) {
      const today = localDate(deps.now().toISOString(), carrier.fuso);
      const days = businessDaysBetween(localDate(shipment.cadastrado_em, carrier.fuso), today, deps.holidays);
      if (days > deps.diasParaPostagem) {
        const ok = emitNotice(deps, {
          tipo: "ainda_nao_postado",
          envioId: shipment.id,
          chave: `nao_postado:${shipment.id}`,
          detalhes: { cadastrado_em: inZone(shipment.cadastrado_em, carrier.fuso), dias_uteis_desde_cadastro: days, limite: deps.diasParaPostagem },
        });
        if (ok) summary.avisos_emitidos.push({ envio: shipment.id, tipo: "ainda_nao_postado" });
      }
    }
  }
  return summary;
}

export function listNotices(deps: Deps, filters: { tipo?: string; envio?: string }) {
  const rows = deps.db.prepare("SELECT tipo, envio_id, criado_em, detalhes_json FROM avisos ORDER BY id").all() as Array<{
    tipo: string;
    envio_id: string | null;
    criado_em: string;
    detalhes_json: string;
  }>;
  return rows
    .filter((row) => (!filters.tipo || row.tipo === filters.tipo) && (!filters.envio || row.envio_id === filters.envio))
    .map((row) => ({ tipo: row.tipo, envio: row.envio_id, criado_em: row.criado_em, detalhes: JSON.parse(row.detalhes_json) as unknown }));
}

/** Códigos que ainda não estão na tabela: os não reconhecidos e os traduzidos só pela categoria do agregador. */
export function pendingCodes(deps: Deps) {
  const shipments = deps.db.prepare("SELECT * FROM envios").all() as ShipmentRow[];
  const pending = new Map<string, { transportadora: string; codigo_bruto: string; descricao: string; traduzido_por: string; status_pela_categoria: Status | null; envios: Set<string> }>();
  for (const shipment of shipments) {
    for (const event of situationOf(deps, shipment).eventos) {
      if (event.traduzidoPor === "tabela") continue;
      const key = `${shipment.transportadora}:${normalizeRawCode(event.codigoBruto)}`;
      const entry = pending.get(key) ?? {
        transportadora: shipment.transportadora,
        codigo_bruto: normalizeRawCode(event.codigoBruto),
        descricao: event.descricao,
        traduzido_por: event.traduzidoPor,
        status_pela_categoria: event.status,
        envios: new Set<string>(),
      };
      entry.envios.add(shipment.id);
      pending.set(key, entry);
    }
  }
  return [...pending.values()].map(({ envios, ...entry }) => ({ ...entry, envios_afetados: envios.size }));
}
