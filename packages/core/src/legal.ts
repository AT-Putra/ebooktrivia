// Legal page bodies (S&K terms and privacy policy, spec AC-A10; US-018): Owner-authored plain text,
// never HTML. One format for the admin preview and the public page (M6):
//   - line endings are normalised (CR LF / CR -> LF);
//   - blocks are separated by one or more blank lines;
//   - a block whose first line starts with "# " is a heading (that line), and the rest of the
//     block, if any, a paragraph;
//   - any other block is a paragraph whose lines are kept as they are (numbered or bulleted
//     lines stay as typed).
// The blocks are TEXT: renderers must insert them as text nodes (React does, escaping < > & " '),
// never as HTML, so a body holding markup shows the markup literally.

export type LegalBlock = { readonly kind: "heading"; readonly text: string } | { readonly kind: "paragraph"; readonly lines: readonly string[] };

export function legalBlocks(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  for (const chunk of body.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    const lines = chunk
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "");
    const first = lines[0];
    if (first === undefined) continue;
    if (first.startsWith("# ")) {
      blocks.push({ kind: "heading", text: first.slice(2).trim() });
      if (lines.length > 1) blocks.push({ kind: "paragraph", lines: lines.slice(1) });
    } else {
      blocks.push({ kind: "paragraph", lines });
    }
  }
  return blocks;
}
