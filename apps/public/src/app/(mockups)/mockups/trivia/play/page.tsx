import type { Metadata } from "next";
import { PlayDemo, type StaticState } from "../../../../../components/play/play-demo.tsx";
import { assertMockupsEnabled } from "../../../../../lib/guard.ts";

export const metadata: Metadata = { title: "Soal | Trivia Arena" };
// Per-request render: a build-time notFound() would otherwise be baked in as a static 404.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ state?: string | string[]; set?: string | string[] }>;
}

function parseState(raw: string | string[] | undefined): StaticState | undefined {
  return raw === "correct" || raw === "wrong" || raw === "timeout" ? raw : undefined;
}

function parseSet(raw: string | string[] | undefined): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : 5;
}

/** ?state=correct|wrong|timeout renders each result state statically (screenshots). */
export default async function PlayMockupPage({ searchParams }: PageProps) {
  assertMockupsEnabled();
  const params = await searchParams;
  const initialState = parseState(params.state);
  return (
    <main className="mx-auto min-h-dvh max-w-[640px] px-4 py-4 md:py-8">
      {initialState === undefined ? (
        <PlayDemo setNumber={parseSet(params.set)} />
      ) : (
        <PlayDemo setNumber={parseSet(params.set)} initialState={initialState} />
      )}
    </main>
  );
}
