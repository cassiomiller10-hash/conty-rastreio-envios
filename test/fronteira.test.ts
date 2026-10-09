import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// "O agregador pode ser trocado sem espalhar o formato dele": verificação estática. Os nomes de
// campo e as categorias do agregador só podem aparecer no cliente dele (e no simulador, que é o
// próprio agregador falso).

const SRC = new URL("../src", import.meta.url).pathname;
const ALLOWED = new Set(["agregador/rastreio-falso.ts", "simulador/agregador-falso.ts"]);
const AGGREGATOR_FORMAT = /\b(checkpoints|checkpoint_time|raw_status|tracking_number|expected_delivery|courier|InfoReceived|InTransit|OutForDelivery|AttemptFail|AvailableForPickup)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("fronteira com o agregador", () => {
  it("o formato do agregador só aparece no cliente dele", () => {
    const offenders = files(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => AGGREGATOR_FORMAT.test(readFileSync(join(SRC, path), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("a verificação pega um vazamento de verdade", () => {
    expect(AGGREGATOR_FORMAT.test("const time = body.checkpoint_time;")).toBe(true);
    expect(AGGREGATOR_FORMAT.test("const data = evento.data;")).toBe(false);
  });
});
