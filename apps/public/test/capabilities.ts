// Tests that need something a developer's machine may lack (symbolic links on Windows without the privilege, mkfifo there): on a
// developer's machine they skip with the reason, where CI is set they FAIL, so CI cannot silently stop covering them.
import type { TestContext } from "vitest";

export function requireOrSkip(context: Pick<TestContext, "skip">, available: boolean, why: string): void {
  if (available) return;
  if ((process.env["CI"] ?? "") !== "") throw new Error(`CI must be able to run this test, but: ${why}`);
  context.skip(why);
}
