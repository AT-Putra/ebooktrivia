// Crash failpoints for the chaos tests (test/chaos.int.test.ts): the process kills itself
// (SIGKILL; TerminateProcess on Windows) at exactly one named point, so a crash between two steps
// is reproducible. A failpoint fires only when NODE_ENV is not production AND WORKER_FAILPOINT
// names it; in production it is inert here, and the config loader also refuses the variable.

export const FAILPOINTS = [
  /** relay: jobs added to BullMQ, relayed_at not yet committed. */
  "after_enqueue_before_mark",
  /** outbox consumer: claim (lease) committed, effect not started. */
  "after_claim_before_effect",
  /** conversion consumer: claim (sending + lease) committed, request not sent. */
  "conversion_after_claim",
  /** conversion consumer: request answered by the sink, outcome not recorded. */
  "conversion_after_fire",
] as const;
export type FailpointName = (typeof FAILPOINTS)[number];

export type Failpoint = (name: FailpointName) => void;

export const inertFailpoint: Failpoint = () => undefined;

export function createFailpoint(
  config: { readonly nodeEnv: string; readonly failpoint?: FailpointName | undefined },
  kill: () => void = () => process.kill(process.pid, "SIGKILL"),
): Failpoint {
  const armed = config.failpoint;
  if (config.nodeEnv === "production" || armed === undefined) return inertFailpoint;
  return (name) => {
    if (name === armed) kill();
  };
}
