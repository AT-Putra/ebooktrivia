// Booting the SDK, free of the DOM so it can be tested without one: which script tag is ours, which
// API origin it may talk to, and the wiring of capture, config, visit beacon and services.
import { SDK_PATTERNS } from "@ebooktrivia/core/sdk-contract";
import type { Api } from "./api.ts";
import { type AttributionDeps, current, startCapture } from "./attribution.ts";
import type { CapSolver } from "./cap.ts";
import type { Services } from "./flow.ts";

export interface ScriptInfo {
  /** The resolved `src` of the script tag. */
  readonly src: string;
  /** Its `data-lp` attribute. */
  readonly dataLp: string | null;
}

const LP_KEY = new RegExp(SDK_PATTERNS.lpKey);
/** Where the SDK is served from (api.<DOMAIN>/sdk/): the alias or a versioned file. */
export const SDK_SCRIPT_PATH = /\/sdk\/(?:v1|sdk-v[0-9]+\.[0-9]+\.[0-9]+)\.js$/;
/** Plain http is for a developer's machine and the tests only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The API origin a script was loaded from: https, or http on loopback; anything else is refused. */
export function apiOriginOf(src: string): string | null {
  try {
    const url = new URL(src);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The tag that is this SDK: the one executing (document.currentScript), else, for a script that ran
 * through another route, the one tag with a `data-lp` whose path is exactly the SDK's own. A tag of
 * some other script that happens to carry a `data-lp` is not ours.
 */
export function pickScript(current: ScriptInfo | null, candidates: readonly ScriptInfo[]): ScriptInfo | null {
  if (current !== null && current.src !== "") return current;
  return (
    candidates.find((c) => {
      try {
        return c.dataLp !== null && SDK_SCRIPT_PATH.test(new URL(c.src).pathname);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** The landing page key and API origin of our script tag, or null when it is not safe to run. */
export function bootTarget(script: ScriptInfo | null): { readonly lpKey: string; readonly apiOrigin: string } | null {
  if (script === null) return null;
  const lpKey = script.dataLp ?? "";
  const apiOrigin = apiOriginOf(script.src);
  return LP_KEY.test(lpKey) && apiOrigin !== null ? { lpKey, apiOrigin } : null;
}

export interface ServiceEnv {
  readonly lpKey: string;
  readonly apiOrigin: string;
  /** The landing URL's query string. */
  readonly search: string;
  readonly deps: () => AttributionDeps;
  readonly api: Api;
  readonly cap: CapSolver;
  readonly pixelsFor: Services["pixelsFor"];
  readonly pixelsLoaded: Services["pixelsLoaded"];
  readonly navigate: (url: string) => void;
}

/**
 * Captures the click that needs no config at once (a visitor who leaves before the config arrives
 * keeps it), asks for the config, then resolves the adnet's click id and sends the visit beacon.
 */
export function startServices(env: ServiceEnv): Services {
  const capture = startCapture(env.deps(), env.lpKey, env.search);
  const attribution = () => current(env.deps(), env.lpKey, capture.click());
  let visitId: string | undefined;
  const config = env.api.config();
  void config.then(async (cfg) => {
    if (cfg === null) return;
    capture.resolve(cfg.adnets);
    visitId = (await env.api.visit(attribution())) ?? undefined;
  });
  return {
    config,
    apiOrigin: env.apiOrigin,
    attribution,
    visitId: () => visitId,
    api: env.api,
    cap: env.cap,
    pixelsFor: env.pixelsFor,
    pixelsLoaded: env.pixelsLoaded,
    navigate: env.navigate,
  };
}
