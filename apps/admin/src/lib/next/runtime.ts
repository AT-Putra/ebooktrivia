// The process-wide runtime of the Next.js app, created on first use (not at import, so `next build`
// and the mockup routes need no database or secrets). A failed start is retried on the next
// request. Kept on globalThis so `next dev` module reloads reuse the pool.
import { createRuntime, type AuthRuntime } from "../auth/runtime.ts";

const KEY = Symbol.for("ebooktrivia.admin.runtime");
type Holder = { [KEY]?: Promise<AuthRuntime> | undefined };

export function getRuntime(): Promise<AuthRuntime> {
  const holder = globalThis as Holder;
  holder[KEY] ??= createRuntime(process.env).catch((error: unknown) => {
    holder[KEY] = undefined;
    throw error;
  });
  return holder[KEY];
}
