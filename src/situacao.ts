import { INFORMATIVIDADE, ROTULO, SO_DA_TABELA, type Status } from "./status.ts";
import { businessDaysBetween, inZone, localDate } from "./tempo.ts";
import { type Carrier, normalizeRawCode } from "./transportadoras.ts";

// A situação do envio é SEMPRE recalculada do histórico inteiro de eventos. Nada aqui depende da
// ordem em que os eventos chegaram: chegar em ordem, embaralhado ou repetido dá o mesmo resultado.
// Todas as decisões usam a data do evento segundo a transportadora, nunca a data em que soubemos.

export type StoredEvent = {
  chave: string;
  dataUtc: string;
  dataOriginal: string;
  codigoBruto: string;
  descricao: string;
  local: string | null;
  idAgregador: string | null;
  sugestao: Status | null;
  categoriaAgregador: string | null;
  conhecidoEm: string;
};

export type TranslatedBy = "tabela" | "agregador" | "nenhum";

export type Translation = { status: Status | null; traduzidoPor: TranslatedBy; ignorado: boolean; motivo: string | null };

export type TranslatedEvent = StoredEvent & Translation;

/** Tabela primeiro; categoria do agregador só para status que não mexem em prazo. */
export function translate(event: Pick<StoredEvent, "codigoBruto" | "sugestao" | "categoriaAgregador">, carrier: Carrier): Translation {
  const entry = carrier.codigos[normalizeRawCode(event.codigoBruto)];
  if (entry) {
    if (entry.traducao === "ignorar") {
      return { status: null, traduzidoPor: "tabela", ignorado: true, motivo: "código conhecido que não muda o status" };
    }
    return { status: entry.traducao, traduzidoPor: "tabela", ignorado: false, motivo: null };
  }
  const category = event.categoriaAgregador ?? "?";
  if (event.sugestao && !SO_DA_TABELA.has(event.sugestao)) {
    return {
      status: event.sugestao,
      traduzidoPor: "agregador",
      ignorado: false,
      motivo: `código fora da tabela; traduzido pela categoria '${category}' do agregador`,
    };
  }
  if (event.sugestao) {
    return {
      status: null,
      traduzidoPor: "nenhum",
      ignorado: false,
      motivo: `código fora da tabela; a categoria '${category}' do agregador não é aceita para ${ROTULO[event.sugestao]} (só a tabela define status que mexem em prazo)`,
    };
  }
  return { status: null, traduzidoPor: "nenhum", ignorado: false, motivo: "código fora da tabela e sem categoria do agregador" };
}

export type DeadlineInfo = {
  limite_dias_uteis: number;
  fonte_limite: string;
  dias_uteis_em_transito: number | null;
  atrasado: boolean;
};

export type Situation = {
  status: Status | null;
  statusDesde: string | null;
  /** Evento que define o status atual. */
  eventoAtual: TranslatedEvent | null;
  motivoSemStatus: string | null;
  motivosRevisao: string[];
  postadoEm: string | null;
  entregueEm: string | null;
  prazo: DeadlineInfo;
  eventos: TranslatedEvent[];
  codigosNaoReconhecidos: Array<{ codigoBruto: string; descricao: string }>;
  /** Sem evento reconhecido nem desconhecido (no máximo códigos conhecidos como "ignorar"). */
  semEventoRelevante: boolean;
};

export type SituationInput = {
  eventos: StoredEvent[];
  carrier: Carrier;
  modalidade: string;
  /** Primeira previsão de entrega da transportadora (AAAA-MM-DD), se houve. */
  previsaoInicial: string | null;
  agora: string;
  feriados: ReadonlySet<string>;
};

const byTimeThenKey = (left: StoredEvent, right: StoredEvent) =>
  left.dataUtc.localeCompare(right.dataUtc) || left.chave.localeCompare(right.chave);

/** Mais recente; no empate de horário, a etapa mais informativa; depois a identidade do evento. */
function mostRecent(events: TranslatedEvent[]): TranslatedEvent | null {
  return (
    [...events].sort(
      (left, right) =>
        right.dataUtc.localeCompare(left.dataUtc) ||
        INFORMATIVIDADE[right.status as Status] - INFORMATIVIDADE[left.status as Status] ||
        left.chave.localeCompare(right.chave),
    )[0] ?? null
  );
}

export function computeSituation(input: SituationInput): Situation {
  const { carrier } = input;
  const eventos = input.eventos.map((event) => ({ ...event, ...translate(event, carrier) })).sort(byTimeThenKey);
  const recognized = eventos.filter((event) => event.status !== null);
  const unknown = eventos.filter((event) => event.traduzidoPor === "nenhum");
  const motivosRevisao: string[] = [];

  // "Entregue" é final: vale o primeiro evento de entrega; o que vier depois só vai para revisão.
  const delivery = recognized.filter((event) => event.status === "entregue").sort(byTimeThenKey)[0] ?? null;
  const current = delivery ?? mostRecent(recognized);
  if (delivery) {
    for (const event of eventos) {
      if (!event.ignorado && event.status !== "entregue" && event.dataUtc > delivery.dataUtc) {
        motivosRevisao.push(`evento depois da entrega: ${event.codigoBruto} em ${inZone(event.dataUtc, carrier.fuso)}`);
      }
    }
  }
  const unknownCodes = new Map<string, string>();
  for (const event of unknown) unknownCodes.set(normalizeRawCode(event.codigoBruto), event.descricao);
  for (const [code, description] of unknownCodes) motivosRevisao.push(`código não reconhecido: ${code} (${description})`);

  // O relógio do atraso liga na postagem real: o primeiro evento reconhecido.
  const postadoEm = recognized[0]?.dataUtc ?? null;
  const entregueEm = delivery?.dataUtc ?? null;
  const tableLimit = carrier.limites[input.modalidade];
  let limite = tableLimit ?? carrier.limitePadrao;
  let fonte = `tabela (${carrier.id} ${input.modalidade}${tableLimit === undefined ? ", padrão da transportadora" : ""})`;
  const postedDate = postadoEm ? localDate(postadoEm, carrier.fuso) : null;
  // A PRIMEIRA previsão da transportadora, quando existe: a atual é reajustada para frente.
  if (input.previsaoInicial && postedDate && input.previsaoInicial > postedDate) {
    limite = businessDaysBetween(postedDate, input.previsaoInicial, input.feriados);
    fonte = `primeira previsão da transportadora (${input.previsaoInicial})`;
  }
  // O relógio para na data de entrega segundo a transportadora, não quando soubemos.
  const referenceDate = localDate(entregueEm ?? input.agora, carrier.fuso);
  const dias = postedDate ? businessDaysBetween(postedDate, referenceDate, input.feriados) : null;

  return {
    status: current?.status ?? null,
    statusDesde: current?.dataUtc ?? null,
    eventoAtual: current,
    motivoSemStatus: current ? null : "aguardando primeiro evento reconhecido",
    motivosRevisao,
    postadoEm,
    entregueEm,
    prazo: { limite_dias_uteis: limite, fonte_limite: fonte, dias_uteis_em_transito: dias, atrasado: dias !== null && dias > limite },
    eventos,
    codigosNaoReconhecidos: [...unknownCodes].map(([codigoBruto, descricao]) => ({ codigoBruto, descricao })),
    semEventoRelevante: recognized.length === 0 && unknown.length === 0,
  };
}
