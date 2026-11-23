// A program as an Owner would have it before its first sale, for the tests and the local run of the demo tools (the real thing is made in the
// admin console): published, sales opened `salesStartDaysAgo` days ago and closing in 60 days, 30 grace days, a landing page (with an adnet,
// and a Meta pixel when asked) and `sets` sets of `questions` questions with four options each, the first one correct. Built on seedOrders,
// so `cleanup --run <runId>` retires it the way it retires an orders run. DEV or TEST databases only: it is never called by seed.ts.
import type postgres from "postgres";
import { newRunId, seedOrders } from "./seed-lib.ts";

export interface DemoFixture {
  readonly runId: string;
  readonly slug: string;
  readonly program_id: string;
  readonly landing_page_id: string;
  readonly adnet_id: string;
}

export interface DemoFixtureOptions {
  readonly sets?: number;
  readonly questions?: number;
  readonly salesStartDaysAgo?: number;
  readonly pixel?: boolean;
  readonly priceIdr?: number;
}

export async function createDemoFixture(sql: postgres.Sql, options: DemoFixtureOptions = {}): Promise<DemoFixture> {
  const runId = newRunId();
  const config = await seedOrders(sql, { runId, lpHost: `lt-${runId}.example.test`, postbackUrl: "https://sink.example.test/postback", priceIdr: options.priceIdr ?? 49_000 });
  await sql`UPDATE public.programs SET sales_start_at = now() - make_interval(days => ${options.salesStartDaysAgo ?? 60}) WHERE id = ${config.program_id}`;
  if (options.pixel === true) await sql`UPDATE public.landing_pages SET pixels = ${JSON.stringify({ meta: "123456789012345" })}::text::jsonb WHERE id = ${config.landing_page_id}`;
  for (let position = 1; position <= (options.sets ?? 12); position++) {
    const [set] = await sql<{ id: string }[]>`INSERT INTO public.trivia_sets (program_id, position, title) VALUES (${config.program_id}, ${position}, ${`Set ${String(position)}`}) RETURNING id`;
    for (let q = 1; q <= (options.questions ?? 2); q++) {
      const [question] = await sql<{ id: string }[]>`
        INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds, explanation)
        VALUES (${set?.id ?? ""}, ${q}, ${`Soal ${String(position)}.${String(q)}`}, 10, 20, 'Penjelasan.') RETURNING id`;
      await sql`
        INSERT INTO public.question_options (question_id, position, label, is_correct)
        VALUES (${question?.id ?? ""}, 1, 'Benar', true), (${question?.id ?? ""}, 2, 'Salah', false), (${question?.id ?? ""}, 3, 'Keliru', false), (${question?.id ?? ""}, 4, 'Bukan', false)`;
    }
  }
  return { runId, slug: `lt-${runId}`, program_id: config.program_id, landing_page_id: config.landing_page_id, adnet_id: config.adnet_id };
}
