// The delivery port of the worker (US-025): what worker.ts needs to run deliveries, built once the delivery queue exists.
//
//   process        the delivery.send consumer (deliver.ts): claim, send, record.
//   outboxConsumers  waha.inbound (inbound.ts): the buyer-first replies.
//   nudge          the delivery source of the single order.paid consumer (conversion-outbox.ts OrderPaidNudge list): a PAID order's
//                  due deliveries (the e-mail, at once) are put on the queue now instead of at the next minute sweep. Job ids are
//                  deterministic and the claim is in PostgreSQL, so a repeat or a lost job costs nothing.
//   loops          the pool's status poll (health.ts).
//   sweeps         the unknown-send lookup (resolve-unknown.ts), run with the minute sweepers.
// `deliveriesFromEnv` is the production wiring: real WAHA, SMTP and file access with the messaging private key; without it nothing
// is delivered (worker.ts logs that), exactly like the template test-sends. createDeliveryPort takes the ports, for the tests.
import { openerFromEnv } from "@ebooktrivia/crypto";
import type { Redis } from "ioredis";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import type { OutboxConsumer } from "../outbox-consumer.ts";
import { type Env, optional } from "../env.ts";
import { rowJobId } from "../queues.ts";
import type { WorkerConfig } from "../worker-config.ts";
import type { OrderPaidNudge } from "../conversion-outbox.ts";
import { createEbookFiles, createMailSender, createWahaAccess } from "./access.ts";
import { type DeliveryConfig, loadDeliveryConfig } from "./config.ts";
import { createDelivery, type DeliveryJob } from "./deliver.ts";
import { createSessionPoller } from "./health.ts";
import { createInboundConsumer, INBOUND_TOPIC, lidGateFromValkey } from "./inbound.ts";
import { expireOpenerLeases } from "./opener-sweep.ts";
import type { EbookFiles, MagicLinks, MagicLinksFactory, MailSender, WahaAccess } from "./ports.ts";
import { resolveUnknownDeliveries } from "./resolve-unknown.ts";

export { DELIVERY_QUEUE, DELIVERY_WA_QUEUE, type DeliveryJob } from "./deliver.ts";
export { INBOUND_TOPIC };

export interface DeliveryLoop {
  readonly name: string;
  readonly intervalMs: number;
  readonly tick: () => Promise<boolean>;
}

export interface DeliveryRuntime {
  readonly process: (data: unknown) => Promise<string>;
  readonly outboxConsumers: readonly OutboxConsumer[];
  readonly nudge: OrderPaidNudge;
  readonly loops: readonly DeliveryLoop[];
  readonly sweeps: Readonly<Record<string, () => Promise<unknown>>>;
}

export interface DeliveryPort {
  /** The outbox topics the runtime consumes (known before the database connection is sized). */
  readonly topics: readonly string[];
  create(context: {
    readonly sql: postgres.Sql;
    readonly log: Logger;
    readonly enqueue: (jobs: readonly DeliveryJob[]) => Promise<void>;
    /** The worker's Valkey and its key prefix: the per-lid budget of the inbound phone-side match lives there. Absent: that match is off. */
    readonly valkey?: { readonly client: Pick<Redis, "get" | "set" | "incr" | "expire">; readonly prefix: string };
  }): DeliveryRuntime;
}

export interface DeliveryPorts {
  readonly config: DeliveryConfig;
  readonly waha: WahaAccess;
  readonly mail: MailSender;
  readonly files: EbookFiles;
  readonly magicLinks: MagicLinks;
  readonly random?: () => number;
  /** The human-like pauses' random source (default: the operating system's CSPRNG). A test passes its own. */
  readonly humanRandom?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly clock?: () => number;
}

export function createDeliveryPort(ports: DeliveryPorts): DeliveryPort {
  return {
    topics: [INBOUND_TOPIC],
    create({ sql, log, enqueue, valkey }) {
      const common = {
        sql,
        log,
        config: ports.config,
        waha: ports.waha,
        ...(ports.random === undefined ? {} : { random: ports.random }),
        ...(ports.humanRandom === undefined ? {} : { humanRandom: ports.humanRandom }),
        ...(ports.sleep === undefined ? {} : { sleep: ports.sleep }),
      };
      const delivery = createDelivery({ ...common, mail: ports.mail, files: ports.files, magicLinks: ports.magicLinks, enqueue, ...(ports.clock === undefined ? {} : { clock: ports.clock }) });
      const poll = createSessionPoller({ sql, log, waha: ports.waha });
      return {
        process: (data) => delivery.process(data),
        outboxConsumers: [
          createInboundConsumer({
            ...common,
            delivery,
            files: ports.files,
            ...(ports.clock === undefined ? {} : { clock: ports.clock }),
            ...(valkey === undefined ? {} : { lidGate: lidGateFromValkey(valkey.client, valkey.prefix, ports.config.fileUrlKey) }),
          }),
        ],
        nudge: async (orderId) => {
          // A WhatsApp delivery whose opener already went out (or is in flight, or was given up) waits for the buyer's reply: nothing to hurry.
          const rows = await sql<{ id: string; attempts: number; channel: "email" | "whatsapp" }[]>`
            SELECT d.id, d.attempts, d.channel FROM public.deliveries d
             WHERE d.order_id = ${orderId} AND d.status = 'pending' AND d.not_before <= now()
               AND (d.channel <> 'whatsapp' OR NOT EXISTS (SELECT 1 FROM public.delivery_openers o WHERE o.delivery_id = d.id AND o.status <> 'pending'))`;
          await enqueue(rows.map((r) => ({ channel: r.channel, jobId: rowJobId(r.id, r.attempts), data: { id: r.id } })));
        },
        loops: [
          {
            name: "wa-pool-health",
            intervalMs: ports.config.sessionPollIntervalMs,
            tick: async () => {
              await poll();
              return false;
            },
          },
        ],
        sweeps: {
          resolve_unknown: () => resolveUnknownDeliveries({ sql, log, waha: ports.waha, config: ports.config }),
          opener_lease: () => expireOpenerLeases(sql),
        },
      };
    },
  };
}

/**
 * The production delivery port: real WAHA, SMTP and file access when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (a malformed key,
 * or a missing DOMAIN or payment key, stops the worker); otherwise none, and nothing is delivered.
 */
export function deliveriesFromEnv(env: Env, worker: Pick<WorkerConfig, "dev">, magicLinks: MagicLinksFactory): DeliveryPort | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const config = loadDeliveryConfig(env, worker);
  const opener = openerFromEnv(env);
  return {
    topics: [INBOUND_TOPIC],
    create(context) {
      const ports: DeliveryPorts = {
        config,
        waha: createWahaAccess({ sql: context.sql, opener, config }),
        mail: createMailSender({ sql: context.sql, opener, config }),
        files: createEbookFiles(config),
        magicLinks: magicLinks({ sql: context.sql, playOrigin: config.playOrigin }),
      };
      return createDeliveryPort(ports).create(context);
    },
  };
}
