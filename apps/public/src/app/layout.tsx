import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Russo_One } from "next/font/google";
import type { ReactNode } from "react";
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${russo.variable} ${chakra.variable}`}>
      <body>{children}</body>
    </html>
  );
}
