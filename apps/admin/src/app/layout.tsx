import type { Metadata, Viewport } from "next";
import { Fira_Code, Fira_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Every page is rendered per request: the per-request CSP nonce (proxy.ts) is only applied to
// dynamically rendered pages, and the console reads the session on each request.
export const dynamic = "force-dynamic";

const firaSans = Fira_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-fira-sans",
});
const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-fira-code",
});

export const metadata: Metadata = {
  title: "Admin Console",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="admin-dark" className={`${firaSans.variable} ${firaCode.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
