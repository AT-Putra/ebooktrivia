// A "." (or its full-width forms) between letters or digits makes WhatsApp, and some mail clients, turn the text into a link ("www.x.id",
// "evil.example"). Free text that is put in a message (a buyer's name in a template, the Owner's opening hours in a reply) gets each such dot
// replaced by U+2024 (one dot leader, which looks the same), so no link can be made out of it.
const LINKABLE_DOT = /(?<=[\p{L}\p{N}])[.\u{FF0E}\u{3002}\u{FF61}](?=[\p{L}\p{N}])/gu;

export const neutralizeDots = (value: string): string => value.replace(LINKABLE_DOT, "\u{2024}");
