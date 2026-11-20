// A legal page body as the buyer will read it (core legalBlocks: headings and paragraphs). Every
// block is inserted as a React text node, which escapes < > & " ', so markup in the body is shown
// literally and never runs (no dangerouslySetInnerHTML anywhere). legal-preview.test.ts renders an
// XSS payload through it.
import { legalBlocks } from "@ebooktrivia/core";

export function LegalPreview({ title, body }: { title: string; body: string }) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-sm" data-testid="legal-preview">
      <h3 className="text-base font-semibold">{title}</h3>
      {legalBlocks(body).map((block, i) =>
        block.kind === "heading" ? (
          <h4 key={i} className="font-semibold">
            {block.text}
          </h4>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {block.lines.join("\n")}
          </p>
        ),
      )}
    </article>
  );
}
