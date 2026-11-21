// The browser side of the play login API (lib/play/handlers.ts): same-origin JSON POSTs, which the browser
// sends with the Origin header the server checks. A network failure is `{ status: 0 }`.
export interface ApiAnswer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  /** Retry-After of a 429, in seconds. */
  readonly retryAfterSeconds: number;
}

export async function postJson(path: string, body: unknown): Promise<ApiAnswer> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const parsed: unknown = await response.json().catch(() => ({}));
    const retry = Number(response.headers.get("retry-after") ?? "0");
    return {
      status: response.status,
      body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
      retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0,
    };
  } catch {
    return { status: 0, body: {}, retryAfterSeconds: 0 };
  }
}

/** Where a signed-in player goes (the trivia home, US-027). */
export const AFTER_LOGIN_PATH = "/";
