// The one "Butuh bantuan?" block of the buyer site: the Owner's customer-service (CS) contact as two buttons. It sits at the END of the
// main content column, before any footer, in the same place and with the same look on every buyer page (WCAG 2.2 "Consistent Help"): the
// order page in every state, the order lookup, the login and the magic-link page, the trivia pages and the not-found and error pages.
//
// Renders NOTHING when no CS contact is set (no empty card, no dead button). A number gives "Chat CS via WhatsApp" (https://wa.me/<digits>
// with a prefilled text), an address gives "Email CS" (mailto: with a subject); the opening hours are shown when set. The order page passes
// the order code, which is then (and only then) in the prefilled text and the subject; the block never carries the buyer's name, e-mail or
// phone. A pure component with no hooks: a server page, the order page's client script and the error boundary all render it.
import { type CsContact, hasCsContact } from "@ebooktrivia/core/cs-contact";
import { EnvelopeSimpleIcon, LifebuoyIcon, WhatsappLogoIcon } from "@phosphor-icons/react/ssr";
import { Button } from "@ebooktrivia/ui/components/button";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { csMailHref, csWhatsappHref } from "../../lib/cs/links.ts";
import { t } from "../../lib/t.ts";

export interface HelpCardProps {
  readonly contact: CsContact;
  /** The order code the page knows (order page only): it is put in the prefilled text and the subject. */
  readonly orderCode?: string | undefined;
  /** The width of the column the page puts it in (the card itself is as wide as that column). */
  readonly className?: string | undefined;
}

export function HelpCard({ contact, orderCode, className }: HelpCardProps) {
  if (!hasCsContact(contact)) return null;
  return (
    <section aria-labelledby="help-title" data-testid="help-block" className={cn("flex w-full flex-col gap-3 rounded-2xl border bg-card p-4 text-card-foreground shadow-md md:p-6", className)}>
      <header className="flex items-center gap-2">
        <LifebuoyIcon aria-hidden="true" size={24} weight="duotone" className="shrink-0 text-primary" />
        <h2 id="help-title" className="font-heading text-lg leading-tight">
          {t("help.title")}
        </h2>
      </header>
      <p className="text-base">{t(orderCode === undefined ? "help.intro" : "help.introOrder")}</p>
      {contact.hours === null ? null : (
        <p className="text-base text-muted-foreground" data-testid="help-hours">
          {t("help.hours", { hours: contact.hours })}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {contact.whatsapp === null ? null : (
          <Button asChild variant="default" size="lg" className="w-full sm:w-auto">
            <a href={csWhatsappHref(contact.whatsapp, orderCode)} target="_blank" rel="noopener noreferrer" data-testid="help-whatsapp">
              <WhatsappLogoIcon aria-hidden="true" size={22} weight="fill" />
              {t("help.whatsapp")}
              <span className="sr-only">{t("help.newTab")}</span>
            </a>
          </Button>
        )}
        {contact.email === null ? null : (
          <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
            <a href={csMailHref(contact.email, orderCode)} data-testid="help-email">
              <EnvelopeSimpleIcon aria-hidden="true" size={22} weight="bold" />
              {t("help.email")}
            </a>
          </Button>
        )}
      </div>
    </section>
  );
}
