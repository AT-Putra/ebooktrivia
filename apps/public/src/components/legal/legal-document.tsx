// A published legal page as the buyer reads it: the body through core legalBlocks (headings and
// paragraphs, US-018's one format for the admin preview and this page). Every block is inserted as a
// React text node, which escapes < > & " ', so markup in a body is shown literally and never runs: no
// dangerouslySetInnerHTML anywhere (legal-document.test.ts renders XSS payloads through it).
import { legalBlocks } from "@ebooktrivia/core";
import { t } from "../../lib/t.ts";

const dateFormat = new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" });

export function LegalDocument({ title, body, version, publishedAt }: { title: string; body: string; version: number; publishedAt: Date }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col gap-4 px-4 py-6 md:py-10">
      <article className="flex flex-col gap-4 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8" data-testid="legal-document">
        <header className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl leading-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {t("legal.version", { version })} · {t("legal.published", { date: dateFormat.format(publishedAt) })}
          </p>
        </header>
        {legalBlocks(body).map((block, index) =>
          block.kind === "heading" ? (
            <h2 key={index} className="font-heading text-lg leading-snug">
              {block.text}
            </h2>
          ) : (
            <p key={index} className="whitespace-pre-line text-base [overflow-wrap:anywhere]">
              {block.lines.join("\n")}
            </p>
          ),
        )}
      </article>
    </main>
  );
}
