import { notFound } from "next/navigation";
import { mockupsEnabled } from "./mockups.ts";

/** Call at the top of every mockup page: renders the 404 page when mockups are disabled. */
export function assertMockupsEnabled(): void {
  if (!mockupsEnabled(process.env)) notFound();
}
