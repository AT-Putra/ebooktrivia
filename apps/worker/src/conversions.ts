// The conversion sinks of the worker (US-024; plan M7; AC-T1-T8): the real FireConversion port that
// conversion-fire.ts calls once it has claimed a conversion_events row.
//
//   s2s     the adnet's postback: the MO / MT / reversal URL template of its adnet, macros filled by core
//           renderPostbackUrl (every value percent-encoded; the scheme, host and port are static text that
//           must equal adnets.endpoint_host), `{secret:name}` resolved only from the adnet's OWN conversions
//           secrets bound to that host, decrypted here with the conversions private key and never logged.
//   meta    Meta Conversions API, tiktok  TikTok Events API: InitiateCheckout at MO and Purchase /
//           CompletePayment at MT, with orders.event_id (the browser pixel's event id, so Meta and TikTok dedupe
//           the browser and server events), SHA-256 hashes of the normalised e-mail and phone, fbp / fbc / ttclid
//           passed through, IDR values. The access token is the pixel's sealed CAPI secret (capi.<platform>.<pixel>).
//           Google is browser-only (plan §10 item 2) and has no row.
//   Refunds: Meta and TikTok have no standard refund event, so a refund reverses at the adnet only (S2S).
//
// Every request goes through safe-fetch (https only, no private / loopback / link-local address after DNS
// resolution, no redirects, bounded time and body): the templates are admin-defined and so untrusted.
// Only hashes of identifiers leave the system (the raw e-mail and phone never do), and none is logged. The
// logged URL is the redacted one (`[secret:name]`), and the 4 KB of the answer that is kept has every secret
// value replaced by `***`, in case the sink echoes the request.
//
// A failure BEFORE a request is made (no template, no token, a secret that does not open, a database error, a
// time budget that ran out while the request was being prepared) is a plain failed attempt (retried on the
// schedule), never "maybe sent": nothing left the process. The request itself carries the fire's AbortSignal.
// The payout of an S2S MT is what its claim stored (event.payoutIdr), and a reversal takes back exactly the
// payout its MT reported; only a reversal whose MT has no snapshot falls back to the adnet's current payout.
// A CAPI request is only ever sent to its platform's fixed host (CAPI_HOSTS), checked again here.
import {
  buildMetaCapiRequest,
  buildS2sRequest,
  buildTikTokEventRequest,
  type ConversionEvent,
  createSafeFetch,
  type HttpFetch,
  type PreparedRequest,
  sendConversion,
} from "@ebooktrivia/adapters";
import {
  CAPI_HOSTS,
  CONVERSION_EXCERPT_MAX,
  type CapiPlatform,
  capiSecretName,
  type ConversionKind,
  isIdMobileE164,
  postbackPayout,
  postbackSecretNames,
  postbackStatus,
  redactSecretValues,
  TemplateError,
} from "@ebooktrivia/core";
import { CryptoError, loadConversionSecretResolver, openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import { conversionSecretStore, findCapiSecret } from "@ebooktrivia/db";
import type postgres from "postgres";
import type { ConversionToFire, FireConversion, SinkDedupePolicy } from "./conversion-fire.ts";
import { type Env, optional } from "./env.ts";
import type { Logger } from "./log.ts";
import { raiseAlert } from "./sweepers.ts";
import type { WorkerConfig } from "./worker-config.ts";

/** Meta and TikTok dedupe a repeat of the same event_id, so an uncertain CAPI send is retried; an adnet may not. */
export const capiDedupesByEventId: SinkDedupePolicy = ({ sink }) => sink === "meta" || sink === "tiktok";

export interface ConversionFireDeps {
  readonly sql: postgres.Sql;
  readonly opener: SecretOpener;
  /** createSafeFetch in production (https only, SSRF-safe); tests pass a loopback-enabled one. */
  readonly fetch: HttpFetch;
  /** Graph API version of Meta CAPI requests, e.g. "v24.0". */
  readonly metaApiVersion: string;
  readonly log: Logger;
  /** Default the system clock (the event time of an MT without a paid_at). */
  readonly now?: () => Date;
}

/** A refusal to even try: the attempt is recorded as failed, with a reason that carries no secret or PII. */
class Refused extends Error {}

interface OrderRow {
  id: string;
  buyer_email: string;
  buyer_phone: string;
  ip: string | null;
  fbp: string | null;
  fbc: string | null;
  ttclid: string | null;
  clickid: string | null;
  sub_id: string | null;
  pub: string | null;
  paid_at: Date | null;
  created_at: Date;
  pixels: unknown;
  lp_host: string | null;
}

interface AdnetRow {
  mo_url_template: string | null;
  mt_url_template: string | null;
  reversal_url_template: string | null;
  payout_idr: string;
  endpoint_host: string | null;
}

interface Prepared {
  readonly request: PreparedRequest;
  /** Secret values opened for this request: replaced by `***` in whatever of the answer is logged. */
  readonly secrets: readonly string[];
}

const pixelOf = (pixels: unknown, key: CapiPlatform): string | undefined => {
  const id = typeof pixels === "object" && pixels !== null && !Array.isArray(pixels) ? (pixels as Record<string, unknown>)[key] : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
};

export function createConversionFire(deps: ConversionFireDeps): FireConversion {
  const { sql } = deps;
  const clock = deps.now ?? (() => new Date());

  const loadOrder = async (orderId: string): Promise<OrderRow> => {
    const [order] = await sql<OrderRow[]>`
      SELECT o.id, o.buyer_email, o.buyer_phone, host(o.ip) AS ip, o.fbp, o.fbc, o.ttclid, o.clickid, o.sub_id, o.pub, o.paid_at, o.created_at, lp.pixels,
             (SELECT d.host FROM public.lp_domains d WHERE d.landing_page_id = o.landing_page_id ORDER BY d.created_at, d.host LIMIT 1) AS lp_host
        FROM public.orders o JOIN public.landing_pages lp ON lp.id = o.landing_page_id
       WHERE o.id = ${orderId}`;
    if (order === undefined) throw new Refused("the order of this conversion no longer exists");
    return order;
  };

  async function prepareS2s(event: ConversionToFire, kind: ConversionKind, order: OrderRow): Promise<Prepared> {
    if (event.adnetId === null) throw new Refused("an S2S conversion has no adnet");
    const [adnet] = await sql<AdnetRow[]>`
      SELECT mo_url_template, mt_url_template, reversal_url_template, payout_idr::text AS payout_idr, endpoint_host
        FROM public.adnets WHERE id = ${event.adnetId}`;
    if (adnet === undefined) throw new Refused("the adnet of this conversion no longer exists");
    const template = kind === "mo" ? adnet.mo_url_template : kind === "mt" ? adnet.mt_url_template : adnet.reversal_url_template;
    if (template === null) throw new Refused(`the adnet has no ${kind} postback template`);
    if (adnet.endpoint_host === null) throw new Refused("the adnet has no postback host");
    if (order.clickid === null || order.clickid === "") throw new Refused("the order carries no click id");
    const binding = { adnetId: event.adnetId, host: adnet.endpoint_host };
    const resolver = await loadConversionSecretResolver(conversionSecretStore(sql), deps.opener, { ...binding, names: postbackSecretNames(template) });
    const secrets: string[] = [];
    const request = buildS2sRequest({
      template,
      values: {
        clickid: order.clickid,
        // Stable per order (orders.id): the adnet dedupes on it, so a re-send never counts twice.
        txid: event.txid,
        payout: postbackPayout(kind, event.payoutIdr ?? Number(adnet.payout_idr)),
        status: postbackStatus(kind),
        ...(order.sub_id === null ? {} : { sub_id: order.sub_id }),
        ...(order.pub === null ? {} : { pub: order.pub }),
      },
      binding,
      resolve: (query) => {
        const secret = resolver(query);
        if (secret !== undefined) secrets.push(secret.value);
        return secret;
      },
    });
    return { request, secrets };
  }

  async function capiToken(platform: CapiPlatform, pixelId: string): Promise<string> {
    const name = capiSecretName(platform, pixelId);
    const row = await findCapiSecret(sql, { name, host: CAPI_HOSTS[platform] });
    if (row === undefined) {
      await raiseAlert(sql, {
        kind: "capi_token_missing",
        severity: "warning",
        dedupeKey: `capi_token_missing:${platform}:${pixelId}`,
        message: `server-side conversions of the ${platform} pixel ${pixelId} are waiting: no CAPI access token is set for it (Landing pages in the admin console)`,
        payload: { platform },
      }).catch(() => false);
      throw new Refused(`no ${platform} CAPI access token is set for this pixel`);
    }
    return deps.opener.openSecret(row);
  }

  async function prepareCapi(event: ConversionToFire, platform: CapiPlatform, kind: "mo" | "mt", order: OrderRow): Promise<Prepared> {
    const pixelId = pixelOf(order.pixels, platform);
    if (pixelId === undefined) throw new Refused(`the landing page has no ${platform} pixel`);
    if (event.valueIdr === null) throw new Refused("the conversion has no value");
    const accessToken = await capiToken(platform, pixelId);
    const conversion: ConversionEvent = {
      kind,
      // The browser pixel's event id (orders.event_id): the dedupe key of the browser and the server event.
      eventId: event.eventId,
      eventTime: kind === "mt" ? (order.paid_at ?? clock()) : order.created_at,
      // orders.id, the browser Purchase's transaction_id (US-022); the public id is an order-page capability.
      orderId: event.txid,
      valueIdr: event.valueIdr,
      email: order.buyer_email,
      ...(isIdMobileE164(order.buyer_phone) ? { phone: order.buyer_phone } : {}),
      ...(order.ip === null ? {} : { clientIp: order.ip }),
      ...(order.lp_host === null ? {} : { pageUrl: `https://${order.lp_host}/` }),
      ...(order.fbp === null ? {} : { fbp: order.fbp }),
      ...(order.fbc === null ? {} : { fbc: order.fbc }),
      ...(order.ttclid === null ? {} : { ttclid: order.ttclid }),
    };
    const request =
      platform === "meta"
        ? buildMetaCapiRequest({ apiVersion: deps.metaApiVersion, pixelId, accessToken, event: conversion })
        : buildTikTokEventRequest({ pixelCode: pixelId, accessToken, event: conversion });
    if (request === null) throw new Refused(`${platform} has no event for a ${kind}`);
    // The token travels in this request: it goes to the platform's own host and nowhere else, whatever a builder did.
    if (new URL(request.url).host !== CAPI_HOSTS[platform]) throw new Refused(`the ${platform} request is not for ${CAPI_HOSTS[platform]}`);
    return { request, secrets: [accessToken] };
  }

  async function prepare(event: ConversionToFire): Promise<Prepared> {
    const kind = event.kind;
    if (kind !== "mo" && kind !== "mt" && kind !== "reversal") throw new Refused("unknown conversion kind");
    const order = await loadOrder(event.orderId);
    switch (event.sink) {
      case "s2s":
        return prepareS2s(event, kind, order);
      case "meta":
      case "tiktok":
        // CAPI has no reversal (plan: Meta and TikTok have no standard refund event).
        if (kind === "reversal") throw new Refused(`${event.sink} has no reversal event`);
        return prepareCapi(event, event.sink, kind, order);
      default:
        throw new Refused(`no sender for the ${event.sink} sink`);
    }
  }

  return async (event, signal) => {
    let prepared: Prepared;
    try {
      prepared = await prepare(event);
    } catch (error) {
      // Nothing was sent. The reason is ours (a Refused message) or a type name: never a value (a template error
      // may name a macro but not its value; a database or crypto error is reduced to its class).
      const reason =
        error instanceof Refused
          ? error.message
          : error instanceof CryptoError
            ? "a secret could not be opened"
            : error instanceof TemplateError
              ? `the postback template is refused: ${error.message}`
              : error instanceof RangeError
                ? `the conversion cannot be built: ${error.message}`
                : "the conversion could not be prepared";
      deps.log.warn({ conversionEventId: event.id, sink: event.sink, kind: event.kind, reason }, "conversion not sent: nothing left the process");
      return { outcome: { kind: "failed", httpStatus: null, error: reason }, latencyMs: 0, responseSnippet: "", requestUrlRedacted: null };
    }
    const { request, secrets } = prepared;
    // The time budget (the fire's AbortSignal) may have run out while the request was prepared: it is not sent then.
    if (signal.aborted) {
      deps.log.warn({ conversionEventId: event.id, sink: event.sink, kind: event.kind }, "conversion not sent: the time budget ran out before the request");
      return { outcome: { kind: "failed", httpStatus: null, error: "the time budget ran out before the request was sent" }, latencyMs: 0, responseSnippet: "", requestUrlRedacted: null };
    }
    const sent = await sendConversion(deps.fetch, request, Date.now, signal);
    const outcome =
      sent.outcome.kind === "sent" ? sent.outcome : { ...sent.outcome, error: redactSecretValues(sent.outcome.error, secrets) };
    return {
      outcome,
      latencyMs: sent.latencyMs,
      responseSnippet: redactSecretValues(sent.responseSnippet, secrets).slice(0, CONVERSION_EXCERPT_MAX),
      requestUrlRedacted: request.redacted.url,
    };
  };
}

/** The worker's conversions port (US-024): the fire port, built on the worker's pool once it is open. */
export interface ConversionPort {
  readonly fire: (sql: postgres.Sql, log: Logger) => FireConversion;
  readonly sinkDedupesByTxid: SinkDedupePolicy;
  readonly close?: () => Promise<void>;
}

/**
 * The conversions port when worker.env holds SECRETS_CONVERSIONS_PRIVATE_KEY (a malformed key stops the worker),
 * otherwise none: then no conversion is sent (the MO and `order.paid` consumers are not registered and the
 * conversions sweeper enqueues nothing). Requests go through a strict safe-fetch, bounded by the conversion
 * timeout (WORKER_CONVERSION_TIMEOUT_MS); the dev flags only reach it outside production (worker-config.ts).
 */
export function conversionsFromEnv(env: Env, config: Pick<WorkerConfig, "dev" | "conversionTimeoutMs" | "metaGraphVersion">): ConversionPort | undefined {
  if (optional(env, "SECRETS_CONVERSIONS_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  if (!opener.scopes.includes("conversions")) return undefined;
  const safeFetch = createSafeFetch({ allowHttp: config.dev.allowHttp, devAllowLoopback: config.dev.allowLoopback, timeoutMs: config.conversionTimeoutMs });
  return {
    fire: (sql, log) => createConversionFire({ sql, opener, fetch: safeFetch, metaApiVersion: config.metaGraphVersion, log }),
    sinkDedupesByTxid: capiDedupesByEventId,
    close: () => safeFetch.close(),
  };
}
