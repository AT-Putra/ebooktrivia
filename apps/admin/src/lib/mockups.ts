export interface MockupEnv {
  NODE_ENV?: string | undefined;
  ENABLE_MOCKUPS?: string | undefined;
}

/** Mockup routes exist in dev/test, and in production builds only when ENABLE_MOCKUPS=1. */
export function mockupsEnabled(env: MockupEnv): boolean {
  return env.NODE_ENV !== "production" || env.ENABLE_MOCKUPS === "1";
}
