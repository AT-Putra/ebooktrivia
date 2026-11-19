import Link from "next/link";
import { LockKeyIcon } from "@phosphor-icons/react/ssr";

/** Rendered with status 403 by forbidden() (lib/next/require-admin.ts). */
export default function Forbidden() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-4 text-center">
      <LockKeyIcon aria-hidden="true" size={32} weight="duotone" className="text-muted-foreground" />
      <h1 className="text-xl font-semibold">403: not allowed</h1>
      <p className="text-sm text-muted-foreground">Your role does not include this page or action. Ask the Owner if you need it.</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-4">
        Back to the overview
      </Link>
    </main>
  );
}
