import type { CsContact } from "@ebooktrivia/core/cs-contact";

export interface MockupEnv {
  NODE_ENV?: string | undefined;
  ENABLE_MOCKUPS?: string | undefined;
}

/** Mockup routes exist in dev/test, and in production builds only when ENABLE_MOCKUPS=1. */
export function mockupsEnabled(env: MockupEnv): boolean {
  return env.NODE_ENV !== "production" || env.ENABLE_MOCKUPS === "1";
}

/** The sample CS contact the mockup pages show in the shared help block (components/help). */
export const MOCKUP_CS_CONTACT: CsContact = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };
