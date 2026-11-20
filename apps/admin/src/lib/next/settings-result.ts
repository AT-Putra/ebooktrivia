// The result of a settings server action (US-017): the body returns the confirmation text, an
// InvalidInput becomes the form's error message (fixed texts, never a submitted value), and
// anything else propagates to adminAction (logged as type + code, answered with a bare error).
// NotAllowed (a role refused inside the change's transaction, US-018) becomes the form's message
// too: Staff who loaded a trivia set before its first attempt see why their save was refused
// (code review US-018 F9), not a 403 page. Nothing was written either way.
import { revalidatePath } from "next/cache";
import type { SaveState } from "../form-state.ts";
import { InvalidInput, NotAllowed } from "../settings/fields.ts";

/** `layout`: revalidate every page under `path` (dynamic segments such as /settings/trivia/[programId]). */
export async function saveResult(path: string, run: () => Promise<string>, scope?: "layout"): Promise<SaveState> {
  try {
    const message = await run();
    if (scope === undefined) revalidatePath(path);
    else revalidatePath(path, scope);
    return { status: "saved", at: Date.now(), message };
  } catch (error) {
    if (error instanceof InvalidInput || error instanceof NotAllowed) return { status: "error", at: Date.now(), error: error.message };
    throw error;
  }
}
