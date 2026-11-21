// What the question screen (a client component) needs of the server's timing rules, without importing
// @ebooktrivia/core's index into the browser bundle (it pulls in node: modules). timing.test.ts keeps it equal
// to core.

/** core rescore.ts ANSWER_LATENCY_GRACE_MS (plan §10 item 5): a pick still counts this long after the deadline. */
export const LATENCY_GRACE_MS = 1500;
