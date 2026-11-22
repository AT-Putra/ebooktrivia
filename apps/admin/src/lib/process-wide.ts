// One value per PROCESS, not per module copy (US-031). Next.js bundles a module more than once (the server actions, the
// route handlers, the pages, instrumentation.ts), and a plain module-level `let` or store then exists once per bundle:
// a per-process limit (argon2's 4 at a time, one landing-page publish, one XLSX parse queue) quietly becomes one per
// bundle, and a store one bundle writes is empty in another (lib/audit.ts, the recovery code sign-in). State that must be
// per process lives here, on globalThis, like the runtime (lib/next/runtime.ts).
export function processWide<T>(name: string, init: () => T): T {
  const holder = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(`ebooktrivia.admin.${name}`);
  holder[key] ??= init();
  return holder[key] as T;
}
