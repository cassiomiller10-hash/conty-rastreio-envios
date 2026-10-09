import { Hono } from "hono";

// Simulador do agregador "Rastreio Falso", rodando como serviço HTTP. Ele é o mundo externo: fala o
// formato do agregador e deixa os testes programarem os problemas reais (eventos repetidos,
// embaralhados, ids que mudam a cada consulta, previsão, falha e demora).

export type Checkpoint = {
  id?: string;
  checkpoint_time: string;
  raw_status: string;
  message: string;
  location: string | null;
  tag: string | null;
};

type Tracking = { courier: string; tracking_number: string; service: string; expected_delivery: string | null; checkpoints: Checkpoint[] };

export class FakeAggregator {
  readonly app = new Hono();
  readonly calls: string[] = [];
  /** Cada consulta devolve os checkpoints numa ordem diferente. */
  shuffle = false;
  /** Cada consulta dá ids novos aos mesmos checkpoints (alguns agregadores fazem isso). */
  unstableIds = false;
  private readonly trackings = new Map<string, Tracking>();
  private readonly failures: Array<{ status: number } | { hang: true }> = [];
  private seed = 7;
  private idCounter = 0;

  constructor(private readonly apiKey = "chave-de-teste") {
    this.app.use("/v1/*", async (c, next) => {
      if (c.req.header("x-api-key") !== this.apiKey) return c.json({ meta: { code: 401, message: "Invalid API key" } }, 401);
      await next();
    });

    this.app.post("/v1/trackings", async (c) => {
      this.calls.push("POST /v1/trackings");
      const failure = await this.nextFailure(c.req.raw.signal);
      if (failure) return c.json({ meta: { code: failure } }, failure as 500);
      const body = (await c.req.json()) as { tracking_number: string; courier: string; service: string };
      const key = `${body.courier}:${body.tracking_number}`;
      if (this.trackings.has(key)) return c.json({ meta: { code: 4003, message: "Tracking already exists." } }, 409);
      this.trackings.set(key, { courier: body.courier, tracking_number: body.tracking_number, service: body.service, expected_delivery: null, checkpoints: [] });
      return c.json({ tracking: this.trackings.get(key) }, 201);
    });

    this.app.get("/v1/trackings/:courier/:number", async (c) => {
      this.calls.push(`GET /v1/trackings/${c.req.param("courier")}/${c.req.param("number")}`);
      const failure = await this.nextFailure(c.req.raw.signal);
      if (failure) return c.json({ meta: { code: failure } }, failure as 500);
      const tracking = this.trackings.get(`${c.req.param("courier")}:${c.req.param("number")}`);
      if (!tracking) return c.json({ meta: { code: 4004, message: "Tracking does not exist." } }, 404);
      let checkpoints = tracking.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        id: this.unstableIds ? `cp_${++this.idCounter}` : checkpoint.id,
      }));
      if (this.shuffle) checkpoints = this.shuffled(checkpoints);
      return c.json({
        tracking_number: tracking.tracking_number,
        courier: tracking.courier,
        service: tracking.service,
        expected_delivery: tracking.expected_delivery,
        checkpoints,
      });
    });

    // Controles da simulação, para demonstração com curl no npm run dev.
    this.app.post("/_simulacao/:courier/:number/checkpoints", async (c) => {
      this.addCheckpoint(c.req.param("courier"), c.req.param("number"), (await c.req.json()) as Checkpoint);
      return c.json({ ok: true }, 201);
    });
  }

  addCheckpoint(courier: string, number: string, checkpoint: Checkpoint): void {
    const tracking = this.require(courier, number);
    tracking.checkpoints.push({ ...checkpoint, id: checkpoint.id ?? `cp_${++this.idCounter}` });
  }

  setExpectedDelivery(courier: string, number: string, date: string | null): void {
    this.require(courier, number).expected_delivery = date;
  }

  /** As próximas chamadas falham com esse status, ou ficam sem responder. */
  failNext(...failures: Array<{ status: number } | { hang: true }>): void {
    this.failures.push(...failures);
  }

  private require(courier: string, number: string): Tracking {
    const tracking = this.trackings.get(`${courier}:${number}`);
    if (!tracking) throw new Error(`rastreio ${courier}:${number} não cadastrado no simulador`);
    return tracking;
  }

  private async nextFailure(signal: AbortSignal): Promise<number | null> {
    const failure = this.failures.shift();
    if (!failure) return null;
    if ("hang" in failure) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return 499;
    }
    return failure.status;
  }

  private shuffled<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      this.seed = (this.seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = this.seed % (i + 1);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }
}
