// A customer's contact details as the console shows them: in full, to the Owner and to Staff (the Owner's decision of
// 2026-11-25: "don't censor the customer data like name and their wa number and email"). The public trivia site and the
// logs stay masked. A person erased by a deletion request (US-030) has no name, phone or e-mail left, and says so.

/** The name, then the WhatsApp number and the e-mail on their own lines; any of them may be missing. */
export function BuyerContact({ name, phone, email, testId }: { name: string | null; phone: string | null; email?: string | null; testId?: string }) {
  const erased = (name === null || name === "") && phone === null && (email === undefined || email === null || email === "");
  if (erased) {
    return (
      <span className="text-muted-foreground italic" data-testid={testId}>
        Erased (data deletion)
      </span>
    );
  }
  return (
    <span className="flex min-w-40 flex-col" data-testid={testId}>
      <span className="[overflow-wrap:anywhere]">{name === null || name === "" ? "No name" : name}</span>
      {phone === null ? null : <span className="font-mono text-xs text-muted-foreground tabular">{phone}</span>}
      {email === undefined || email === null || email === "" ? null : <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{email}</span>}
    </span>
  );
}
