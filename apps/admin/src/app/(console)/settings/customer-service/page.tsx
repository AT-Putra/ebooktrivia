import type { Metadata } from "next";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { csLocalPhone } from "@ebooktrivia/core";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { csPreview, getCsContact } from "../../../../lib/settings/cs-contact.ts";
import { saveCsContactAction } from "./actions.ts";

export const metadata: Metadata = { title: "Customer service | Admin Console" };

/** Owner only: the number, address and hours a buyer with a problem is shown, on every buyer page and in a few WhatsApp replies. */
export default async function CustomerServicePage() {
  await requireAdmin({ permission: "cs_contact.edit" });
  const { sql } = await getRuntime();
  const contact = await getCsContact(sql);
  const preview = csPreview(contact);
  return (
    <>
      <PageHeading
        title="Customer service"
        description="Where a buyer with a problem reaches a person: a WhatsApp number, an e-mail address and the hours. Each may be left empty, and an empty one is shown nowhere. Every change is audited."
      />
      <Card>
        <CardTitle className="text-base">Contact</CardTitle>
        <CardDescription>
          The WhatsApp number must be a number a person answers, never one of the sending numbers in Settings, WhatsApp: it is refused there, and a sending number cannot be given this number later. The
          buyer pages show these within a minute.
        </CardDescription>
        <ActionForm action={saveCsContactAction} submitLabel="Save customer service" className="grid gap-3 sm:grid-cols-2" testId="cs-contact-form">
          <TextField
            id="cs-whatsapp"
            name="whatsapp"
            label="Customer service WhatsApp number"
            inputMode="tel"
            required={false}
            maxLength={24}
            defaultValue={contact.whatsapp === null ? undefined : csLocalPhone(contact.whatsapp)}
            placeholder="0812 3456 7890"
            hint="An Indonesian mobile number. Buyers see it as 0812-3456-7890 and reach it with a Chat button."
          />
          <TextField
            id="cs-email"
            name="email"
            label="Customer service e-mail"
            type="email"
            required={false}
            maxLength={254}
            defaultValue={contact.email ?? undefined}
            hint="Buyers reach it with an Email button."
          />
          <div className="sm:col-span-2">
            <TextField
              id="cs-hours"
              name="hours"
              label="Hours (optional)"
              required={false}
              maxLength={80}
              defaultValue={contact.hours ?? undefined}
              placeholder="Senin–Jumat 09.00–17.00 WIB"
              hint="One line of up to 80 characters, shown to buyers as written. No line breaks or invisible characters."
            />
          </div>
        </ActionForm>
      </Card>
      <Card>
        <CardTitle className="text-base">Where buyers see it</CardTitle>
        <CardDescription>
          The help block &ldquo;Butuh bantuan?&rdquo; at the end of every buyer page (order page, order lookup, login, trivia, not-found and error pages). Four fixed WhatsApp replies add a line: when a
          number that is not the buyer&rsquo;s writes to the pool, when the sender cannot be confirmed, when an order cannot be handled by chat, and when the ebook could not be sent by WhatsApp. With
          nothing set, buyers see no block and the replies stay as they were. In a WhatsApp reply a dot between letters or digits in the hours is shown as a look-alike dot, so it cannot become a link; the
          e-mail address is left as it is, and WhatsApp shows it as a link.
        </CardDescription>
        <dl className="grid gap-1 text-sm sm:grid-cols-[12rem_1fr]" data-testid="cs-preview">
          <dt className="font-medium">In a WhatsApp reply</dt>
          <dd data-testid="cs-preview-line">{preview.line === null ? "Nothing is set: the replies carry no customer service line." : `...hubungi CS kami di ${preview.line}.`}</dd>
          <dt className="font-medium">{"{cs_whatsapp}"}</dt>
          <dd>{preview.csWhatsapp === "" ? "(empty)" : preview.csWhatsapp}</dd>
          <dt className="font-medium">{"{cs_email}"}</dt>
          <dd className="[overflow-wrap:anywhere]">{preview.csEmail === "" ? "(empty)" : preview.csEmail}</dd>
        </dl>
      </Card>
      <Card>
        <CardTitle className="text-base">In templates</CardTitle>
        <CardDescription>
          {"{cs_whatsapp}"} and {"{cs_email}"} can be used in the ebook delivery e-mail and the delivery WhatsApp text (Settings, Templates), not in the short openers: an opener stays short and
          link-free. A value that is not set renders as an empty string, so put each variable where the sentence still reads well without it, for example &ldquo;Kendala? Chat CS kami: {"{cs_whatsapp}"}&rdquo;
          rather than &ldquo;Chat CS kami di nomor {"{cs_whatsapp}"} atau email {"{cs_email}"}&rdquo;, and set both values if the text needs both.
        </CardDescription>
      </Card>
    </>
  );
}
