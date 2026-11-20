// States the console's forms show (returned by server actions to useActionState). Kept out of the
// server-action modules, which may only export async functions.

/** `permanent`: hard-locked after too many consecutive failed codes (only a recovery unlocks it). */
export type LockedState = { readonly error: "locked"; readonly retryAfterMinutes: number; readonly permanent: boolean };

export type AuthFormState = { readonly error: null } | { readonly error: "invalid" | "expired" } | LockedState;

export type EnrollStartState =
  | { readonly stage: "password"; readonly error: null | "invalid" | "invalid_new_password" }
  | ({ readonly stage: "password" } & LockedState)
  | { readonly stage: "verify"; readonly secret: string; readonly uri: string; readonly qrSvgDataUrl: string; readonly recoveryCodes: readonly string[] };

export type CodesState = { readonly error: null; readonly recoveryCodes: readonly string[] | null } | { readonly error: "invalid" } | LockedState;

export type ResetState =
  | { readonly status: "idle" }
  | { readonly status: "reset"; readonly at: number }
  | { readonly status: "error"; readonly error: "password" | "not_found" | "self" | "owner" };

export type CreateStaffState =
  | { readonly status: "idle" }
  | { readonly status: "created"; readonly at: number }
  | { readonly status: "error"; readonly error: "email" | "display_name" | "password" | "email_taken" };

export const INITIAL_AUTH: AuthFormState = { error: null };
export const INITIAL_ENROLL: EnrollStartState = { stage: "password", error: null };
export const INITIAL_CODES: CodesState = { error: null, recoveryCodes: null };
export const INITIAL_CREATE: CreateStaffState = { status: "idle" };
export const INITIAL_RESET: ResetState = { status: "idle" };

export const lockedState = (outcome: { readonly retryAfterSeconds: number; readonly permanent: boolean }): LockedState => ({
  error: "locked",
  retryAfterMinutes: minutes(outcome.retryAfterSeconds),
  permanent: outcome.permanent,
});

/** A text field of a submitted form ("" when absent), capped at `max` characters. */
export function formText(form: FormData, name: string, max = 1024): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, max) : "";
}

export const minutes = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

/** What a settings form shows after its server action (US-017): a confirmation or one error. */
export type SaveState =
  | { readonly status: "idle" }
  | { readonly status: "saved"; readonly at: number; readonly message: string }
  | { readonly status: "error"; readonly at: number; readonly error: string };

export const INITIAL_SAVE: SaveState = { status: "idle" };

/** The template preview (US-017): WhatsApp text, or an e-mail document for a sandboxed iframe. */
export type PreviewState =
  | { readonly status: "idle" }
  | { readonly status: "preview"; readonly at: number; readonly channel: "whatsapp" | "email"; readonly subject: string | null; readonly body: string }
  | { readonly status: "error"; readonly at: number; readonly error: string };

export const INITIAL_PREVIEW: PreviewState = { status: "idle" };
