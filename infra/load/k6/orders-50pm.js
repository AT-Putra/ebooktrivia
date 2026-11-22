// k6 load test of AC-P8: 50 orders per minute for 10 minutes through the REAL checkout (the SDK's own request), each
// with a Cap token and a Snap transaction created in the Midtrans SANDBOX. Run from a separate machine against staging
// (infra/load/run.sh orders), right after cap-pool.ts made the tokens. "No lost orders, duplicate MTs or delivery jobs" is
// proven afterwards by verify-p8.ts over the database (the reconciliation identity), not by this script: k6 only knows the
// answers it got. This script's own thresholds make k6 exit non-zero (99) when:
//   - checkout answers an error for more than 1 % of the orders (a 502 from a flaky sandbox is rare, not routine);
//   - an iteration was dropped (k6 could not start an order on time: the load generator or the app fell behind the rate);
//   - a Cap token was missing or already expired (the pool is too small or too old: run.sh makes it right before the run);
//   - any check fails (a 200 with a new order, the Snap redirect on Midtrans' host, the event id).
// Every order is a new buyer (unique phone, e-mail, name), attributed to the run's adnet with a click id, so each PAID order
// owns one s2s MT row: the verifier's identity. The buyer details are synthetic: WhatsApp sends MUST be off for the run
// (README, "Limits for the run"); the e-mail goes to EMAIL_DOMAIN, a domain the operator controls.
//
// ENV  API_ORIGIN (required)   https://api.<DOMAIN>
//      ORDERS_CONFIG (/work/orders-config.json)  seed.ts orders' output;  CAP_POOL (/work/cap-pool.json)  cap-pool.ts' output
//      EMAIL_DOMAIN (required)  RUN_SEED (required)  RATE_PER_MIN (50)  DURATION (10m)  PRE_VUS (40)  MAX_VUS (300)
//      LP_ORIGIN     the Origin header (default https://<lp_host of the config>);  HOST_HEADER overrides Host (local dry runs only)
//      BASE_URL      where to connect (default API_ORIGIN)
import { check } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { buyerFor } from "./lib.js";

const CONFIG = JSON.parse(open(__ENV.ORDERS_CONFIG || "/work/orders-config.json"));
const POOL = new SharedArray("cap", () => JSON.parse(open(__ENV.CAP_POOL || "/work/cap-pool.json")).tokens);
const API_ORIGIN = __ENV.API_ORIGIN;
const EMAIL_DOMAIN = __ENV.EMAIL_DOMAIN;
if (!API_ORIGIN || !EMAIL_DOMAIN) throw new Error("API_ORIGIN and EMAIL_DOMAIN are required");
const BASE_URL = (__ENV.BASE_URL || API_ORIGIN).replace(/\/+$/, "");
const LP_ORIGIN = __ENV.LP_ORIGIN || `https://${CONFIG.lp_host}`;
// One seed for the WHOLE run (every VU computes the same buyers by iteration number): the runner passes it, a random value here would differ per VU.
if (!__ENV.RUN_SEED) throw new Error("RUN_SEED is required (run.sh passes one)");
const RUN_SEED = Number(__ENV.RUN_SEED);
const RUN_TAG = String(RUN_SEED % 1_000_000).padStart(6, "0");
const RATE = Number(__ENV.RATE_PER_MIN || 50);
const SNAP_PREFIX = "https://app.sandbox.midtrans.com/snap/v4/redirection/";

const ordersCreated = new Counter("orders_created");
const ordersDeduped = new Counter("orders_deduped");
const ordersRefused = new Counter("orders_refused");
const capMissing = new Counter("cap_tokens_missing");
const capExpired = new Counter("cap_tokens_expired");
const checkoutDuration = new Trend("checkout_duration", true);

export const options = {
  scenarios: {
    orders: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1m",
      duration: __ENV.DURATION || "10m",
      preAllocatedVUs: Number(__ENV.PRE_VUS || 40),
      maxVUs: Number(__ENV.MAX_VUS || 300),
    },
  },
  thresholds: {
    "http_req_failed{endpoint:checkout}": ["rate<0.01"],
    dropped_iterations: ["count==0"],
    cap_tokens_missing: ["count==0"],
    cap_tokens_expired: ["count==0"],
    checks: ["rate>0.99"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const planned = Math.ceil((RATE * parseDurationMinutes(__ENV.DURATION || "10m")));
  if (POOL.length < planned) throw new Error(`the run plans ${planned} orders but the Cap pool holds ${POOL.length} tokens: make it larger`);
  let soonest = Infinity;
  for (let k = 0; k < POOL.length; k++) soonest = Math.min(soonest, POOL[k].expires);
  if (soonest < Date.now() + 60_000) throw new Error("the Cap pool holds a token that expires within a minute: make a fresh pool right before the run");
  return {};
}

function parseDurationMinutes(text) {
  const match = /^(\d+)(s|m)$/.exec(text);
  if (!match) throw new Error("DURATION must look like 10m or 90s");
  return match[2] === "m" ? Number(match[1]) : Number(match[1]) / 60;
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const token = POOL[i];
  if (!token) {
    capMissing.add(1);
    return;
  }
  if (token.expires <= Date.now()) {
    capExpired.add(1);
    return;
  }
  const buyer = buyerFor(RUN_SEED, RUN_TAG, i, EMAIL_DOMAIN);
  const headers = { Accept: "application/json", "Content-Type": "application/json", Origin: LP_ORIGIN };
  if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
  const body = {
    v: 1,
    name: buyer.name,
    phone: buyer.phone,
    email: buyer.email,
    cap_token: token.token,
    consent: { terms: CONFIG.terms_version, privacy: CONFIG.privacy_version },
    attribution: { adnet: CONFIG.adnet_slug, clickid: buyer.clickid },
  };
  const res = http.post(`${BASE_URL}/api/v1/checkout/${CONFIG.lp_key}`, JSON.stringify(body), { headers, tags: { endpoint: "checkout" } });
  checkoutDuration.add(res.timings.duration);
  let answer = null;
  try {
    answer = res.json();
  } catch {
    answer = null;
  }
  const created = res.status === 200 && answer !== null && answer.deduped === false;
  check(res, {
    "checkout 200": (r) => r.status === 200,
    "a new order (not deduped)": () => answer !== null && answer.deduped === false,
    "Snap redirect on Midtrans' sandbox": () => answer !== null && typeof answer.snap_redirect_url === "string" && answer.snap_redirect_url.startsWith(SNAP_PREFIX),
    "event id": () => answer !== null && typeof answer.event_id === "string" && answer.event_id.length === 36,
  });
  if (created) ordersCreated.add(1);
  else if (res.status === 200) ordersDeduped.add(1);
  else ordersRefused.add(1);
}
