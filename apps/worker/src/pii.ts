// PII masking for text that is stored for operators or leaves the process: outbox.last_error and
// GlitchTip alert rows (relayed to WhatsApp / email). Email addresses become "[email]" and
// phone-like numbers become "[number]": 8 or more digits, optional "+", single space / "." / "-"
// separators allowed between digits ("+62 812-3456-7890", "0812 3456 7890", "0812.3456.7890").
// Two shapes of such runs are left readable on purpose: an ISO date with an optional hour
// ("2026-11-13", "2026-11-13 10" of "2026-11-13 10:00:00") and dot-grouped thousands
// ("12.500.000", which also keeps dotted IPv4 such as "192.168.100.200" as before).
// Both patterns are linear: the email parts are length-bounded (an unbounded local part
// backtracked quadratically, about 3 s on one 64 KB GlitchTip string), and each repetition of
// the number pattern consumes a digit.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const NUMBER = /\+?\d(?:[ .-]?\d){7,}/g;
const READABLE = [/^\d{4}-\d{2}-\d{2}(?: \d{2})?$/, /^\d{1,3}(?:\.\d{3})+$/];

export const maskPii = (text: string): string =>
  text.replace(EMAIL, "[email]").replace(NUMBER, (run) => (READABLE.some((shape) => shape.test(run)) ? run : "[number]"));
