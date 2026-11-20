// The result of a settings server action (US-017): the body returns the confirmation text, an
// InvalidInput becomes the form's error message (fixed texts, never a submitted value), and
// anything else propagates to adminAction (logged as type + code, answered with a bare error).
import { revalidatePath } from "next/cache";
import type { SaveState } from "../form-state.ts";
import { InvalidInput } from "../settings/fields.ts";

export async function saveResult(path: string, run: () => Promise<string>): Promise<SaveState> {
  try {
    const message = await run();
    revalidatePath(path);
    return { status: "saved", at: Date.now(), message };
  } catch (error) {
    if (error instanceof InvalidInput) return { status: "error", at: Date.now(), error: error.message };
    throw error;
  }
}
