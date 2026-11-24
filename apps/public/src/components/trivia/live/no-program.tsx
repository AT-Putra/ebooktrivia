// What the trivia home says to a player who has no program to play (yet): the note, a pointer to the help block only while there is a help block
// ("Hubungi CS di bawah." must never point at nothing), and the shared help block itself, as the last thing of the column.
import { type CsContact, hasCsContact } from "@ebooktrivia/core/cs-contact";
import { t } from "../../../lib/t.ts";
import { HelpCard } from "../../help/help-card.tsx";

export function NoProgram({ contact }: { readonly contact: CsContact }) {
  return (
    <>
      <h1 className="font-heading text-2xl">{t("trivia.live.noProgramTitle")}</h1>
      <p className="text-base">{t("trivia.live.noProgramBody")}</p>
      {hasCsContact(contact) ? (
        <p className="text-base font-semibold" data-testid="no-program-help-pointer">
          {t("help.noProgramPointer")}
        </p>
      ) : null}
      <HelpCard contact={contact} />
    </>
  );
}
