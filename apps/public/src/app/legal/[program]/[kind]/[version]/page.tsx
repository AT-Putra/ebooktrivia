// play.<DOMAIN>/legal/{program}/{kind}/{version} (US-022, AC-A10): the S&K and privacy pages the consent
// checkbox links to. Served on the play origin only (src/proxy.ts). Only a PUBLISHED version is shown; an
// unknown program, a draft and a malformed address are the same 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalDocument } from "../../../../../components/legal/legal-document.tsx";
import { parseLegalRequest, publishedLegalPage } from "../../../../../lib/legal.ts";
import { getRuntime } from "../../../../../lib/runtime.ts";
import { t } from "../../../../../lib/t.ts";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ program: string; kind: string; version: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { kind } = await params;
  return { title: `${kind === "privacy" ? t("legal.privacy") : t("legal.terms")} | ${t("common.appName")}`, referrer: "strict-origin-when-cross-origin" };
}

export default async function LegalPage({ params }: PageProps) {
  const { program, kind, version } = await params;
  const request = parseLegalRequest(program, kind, version);
  if (request === undefined) notFound();
  const { order } = await getRuntime();
  const page = await publishedLegalPage(order.sql, request);
  if (page === undefined) notFound();
  return <LegalDocument title={page.title} body={page.body} version={page.version} publishedAt={page.publishedAt} />;
}
