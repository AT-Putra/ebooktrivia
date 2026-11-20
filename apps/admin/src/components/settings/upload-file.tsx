"use client";

// Sends one file as the raw body of a POST to a content route (US-018, lib/next/content-routes.ts):
// a question image, set thumbnail or prize image, or a CSV / XLSX question import. The server checks
// everything again; an import with bad rows answers 422 with every row number and reason, and then
// nothing was written.
import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError } from "../auth/auth-card.tsx";

const MAX_BYTES = 2 * 1024 * 1024;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "rows"; readonly errors: readonly { readonly row: number; readonly message: string }[] };

export function UploadFile({ id, url, label, accept, mode, testId }: { id: string; url: string; label: string; accept: string; mode: "image" | "import"; testId?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function send(file: File): Promise<void> {
    setPhase({ kind: "sending" });
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": file.type === "" ? "application/octet-stream" : file.type, "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; errors?: unknown; imported?: unknown };
      if (response.status === 422 && Array.isArray(body.errors)) {
        setPhase({ kind: "rows", errors: body.errors as { row: number; message: string }[] });
        return;
      }
      if (!response.ok) {
        setPhase({ kind: "error", message: typeof body.error === "string" ? body.error : "The upload was refused." });
        return;
      }
      setPhase({ kind: "done", message: mode === "import" ? `${String(body.imported)} questions imported.` : "Image saved." });
      router.refresh();
    } catch {
      setPhase({ kind: "error", message: "The upload failed. Check the connection and try again." });
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (file.size > MAX_BYTES) {
      setPhase({ kind: "error", message: "The file is larger than 2 MB." });
      return;
    }
    void send(file);
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="file"
        accept={accept}
        onChange={onChange}
        disabled={phase.kind === "sending"}
        className="max-w-full text-sm file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:text-on-secondary"
      />
      {phase.kind === "sending" ? (
        <p role="status" className="text-sm">
          Uploading...
        </p>
      ) : null}
      {phase.kind === "done" ? (
        <p role="status" className="text-sm">
          {phase.message}
        </p>
      ) : null}
      {phase.kind === "error" ? <FormError>{phase.message}</FormError> : null}
      {phase.kind === "rows" ? (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm" data-testid="import-errors">
          <p className="font-medium">Nothing was imported: fix these rows and upload the file again.</p>
          <ul className="flex flex-col gap-0.5">
            {phase.errors.map((e) => (
              <li key={`${String(e.row)}-${e.message}`}>
                Row {e.row}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
