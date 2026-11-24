// The shared help block for a SERVER component (a page): reads the CS contact (cached, lib/cs/contact.ts; a failed read renders no block)
// and renders the one HelpCard. A client component uses ContextHelpBlock (cs-context.tsx) instead.
import { getCsContact } from "../../lib/cs/contact.ts";
import { HelpCard } from "./help-card.tsx";

export async function HelpBlock({ orderCode, className }: { readonly orderCode?: string | undefined; readonly className?: string | undefined }) {
  return <HelpCard contact={await getCsContact()} orderCode={orderCode} className={className} />;
}
