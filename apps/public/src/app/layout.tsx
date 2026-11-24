import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Russo_One } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { CsContactProvider } from "../components/help/cs-context.tsx";
import { getCsContact } from "../lib/cs/contact.ts";
import "./globals.css";

const russo = Russo_One({ subsets: ["latin"], weight: "400", display: "swap", variable: "--font-russo" });
const chakra = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-chakra",
});

export const metadata: Metadata = {
  title: "Trivia Arena",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * The CS contact (the buyer site's help block, components/help) is read here once per request and handed to the client components (the
 * order page's script, the login forms, the error boundary) through CsContactProvider. It changes while the site runs, so every page is
 * rendered per request (`connection()`), never baked in at build; the read is cached for a short time, and a failed read only means no
 * help block (lib/cs/contact.ts), never a page that does not render.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const contact = await getCsContact();
  return (
    <html lang="id" className={`${russo.variable} ${chakra.variable}`}>
      <body>
        <CsContactProvider contact={contact}>{children}</CsContactProvider>
      </body>
    </html>
  );
}
