// Next.js calls register() once when a server process starts. Node runtime only, and never during
// `next build` (code review US-017 F8: the build may load this file; no sweeper must start there).
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  if (process.env["NEXT_PHASE"] === "phase-production-build") return;
  const { startUploadSweeper } = await import("./lib/next/upload-sweeper.ts");
  startUploadSweeper();
  const { startLpHostingSweeper } = await import("./lib/next/lp-hosting-sweeper.ts");
  startLpHostingSweeper();
}
