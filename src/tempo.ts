// Datas: instantes guardados em UTC; dia civil, hora local e dias úteis sempre no fuso da
// transportadora, nunca no fuso do servidor.

const offsetFormat = new Map<string, Intl.DateTimeFormat>();
const partsFormat = new Map<string, Intl.DateTimeFormat>();

function cached(map: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions) {
  let format = map.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    map.set(timeZone, format);
  }
  return format;
}

/** Diferença do fuso para UTC, em minutos, naquele instante (ex.: -180 em Brasília). */
function offsetMinutes(instant: number, timeZone: string): number {
  const name = cached(offsetFormat, timeZone, { timeZoneName: "longOffset" })
    .formatToParts(new Date(instant))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function localParts(instant: number, timeZone: string) {
  const parts = cached(partsFormat, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}:${get("second")}` };
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const WITH_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Converte a data como a transportadora informou para um instante UTC (ISO). Com fuso, respeita o
 * fuso; sem fuso, interpreta no fuso da transportadora. Devolve null se não for uma data.
 */
export function toInstant(text: string, timeZone: string): string | null {
  const value = text.trim();
  if (WITH_ZONE.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const match = NAIVE.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00"] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Duas passadas para acertar o fuso mesmo perto de uma mudança de horário.
  let instant = asUtc - offsetMinutes(asUtc, timeZone) * 60_000;
  instant = asUtc - offsetMinutes(instant, timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** "2026-10-05T14:12:00-03:00": o instante como a pessoa leria no fuso da transportadora. */
export function inZone(instantIso: string, timeZone: string): string {
  const instant = Date.parse(instantIso);
  const { date, time } = localParts(instant, timeZone);
  const offset = offsetMinutes(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Dia civil (AAAA-MM-DD) do instante no fuso da transportadora. */
export function localDate(instantIso: string, timeZone: string): string {
  return localParts(Date.parse(instantIso), timeZone).date;
}

/**
 * Dias úteis depois de `start` até `end`, inclusive (`start` não conta: o prazo começa no dia útil
 * seguinte à postagem). Sábado, domingo e feriados não contam.
 */
export function businessDaysBetween(start: string, end: string, holidays: ReadonlySet<string>): number {
  let count = 0;
  const day = new Date(`${start}T12:00:00Z`);
  for (;;) {
    day.setUTCDate(day.getUTCDate() + 1);
    const iso = day.toISOString().slice(0, 10);
    if (iso > end) return count;
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(iso)) count += 1;
  }
}
