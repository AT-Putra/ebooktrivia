"use client";

// The CS contact for the client components of a page (the order page's script, the login forms, the error boundary): the root layout reads it
// once per request (lib/cs/contact.ts, cached) and provides it here, so a client component does not fetch it and cannot fail on it. The
// default is "no contact": a component rendered outside the provider shows no help block and no pointer to one.
import { type CsContact, hasCsContact, NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { createContext, type ReactNode, useContext } from "react";
import { HelpCard } from "./help-card.tsx";

const CsContactContext = createContext<CsContact>(NO_CS_CONTACT);

export function CsContactProvider({ contact, children }: { readonly contact: CsContact; readonly children: ReactNode }) {
  return <CsContactContext value={contact}>{children}</CsContactContext>;
}

export const useCsContact = (): CsContact => useContext(CsContactContext);

/** True when the page shows the help block, so an error message may say "Hubungi CS di bawah" and there is something below it. */
export const useHelpShown = (): boolean => hasCsContact(useCsContact());

/** The shared help block, for a client component. */
export function ContextHelpBlock({ orderCode, className }: { readonly orderCode?: string | undefined; readonly className?: string | undefined }) {
  return <HelpCard contact={useCsContact()} orderCode={orderCode} className={className} />;
}
