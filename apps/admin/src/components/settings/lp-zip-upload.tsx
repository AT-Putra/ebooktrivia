"use client";

// Uploads a landing-page ZIP in 1 MiB chunks (US-023, lib/next/lp-zip-route.ts; the same protocol as
// the PDF upload): init with the file's SHA-256, each chunk with its own (retried up to 3 times,
// resumable: init returns the chunks the server has), then complete, which checks and publishes it. A
// refused ZIP answers 422 with every problem found (file and reason), and then nothing was published.
import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError } from "../auth/auth-card.tsx";

const MAX_BYTES = 25 * 1024 * 1024;

interface Issue {
  readonly code: string;
  readonly entry: string | null;
  readonly message: string;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly sent: number; readonly total: number }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "rejected"; readonly issues: readonly Issue[] };

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown>;
}
const NO_ANSWER: Answer = { ok: false, status: 0, body: {} };

async function post(path: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}

const errorOf = (a: Answer, fallback: string): string => (typeof a.body["error"] === "string" ? a.body["error"] : fallback);

export function LpZipUpload({ id, landingPageId }: { id: string; landingPageId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function send(file: File): Promise<void> {
    setPhase({ kind: "sending", sent: 0, total: file.size });
    try {
      const sha256 = await sha256Hex(await file.arrayBuffer());
      const init = await post("/uploads/lp-zip/init", { headers: { "content-type": "application/json" }, body: JSON.stringify({ landingPageId, filename: file.name, size: file.size, sha256 }) });
      if (!init.ok) throw new Error(errorOf(init, "The upload could not start."));
      const sessionId = String(init.body["sessionId"]);
      const chunkBytes = Number(init.body["chunkBytes"]);
      const chunkCount = Number(init.body["chunkCount"]);
      const list: unknown = init.body["received"];
      const received = new Set(Array.isArray(list) ? list.filter((n): n is number => typeof n === "number") : []);
      let sent = received.size * chunkBytes;
      for (let index = 0; index < chunkCount; index++) {
        if (received.has(index)) continue;
        const bytes = await file.slice(index * chunkBytes, Math.min(file.size, (index + 1) * chunkBytes)).arrayBuffer();
        const hash = await sha256Hex(bytes);
        for (let attempt = 1; ; attempt++) {
          const result = await post(`/uploads/lp-zip/chunk?session=${encodeURIComponent(sessionId)}&index=${String(index)}`, {
            headers: { "content-type": "application/octet-stream", "x-chunk-sha256": hash },
            body: bytes,
          }).catch(() => NO_ANSWER);
          if (result.ok) break;
          if (attempt >= 3 || (result.status >= 400 && result.status < 500)) throw new Error(errorOf(result, "A part of the file could not be sent. Choose the file again to resume."));
        }
        sent = Math.min(file.size, sent + bytes.byteLength);
        setPhase({ kind: "sending", sent, total: file.size });
      }
      const done = await post(`/uploads/lp-zip/complete?session=${encodeURIComponent(sessionId)}`, {});
      if (done.status === 422 && Array.isArray(done.body["issues"])) {
        setPhase({ kind: "rejected", issues: done.body["issues"] as Issue[] });
        return;
      }
      if (!done.ok) throw new Error(errorOf(done, "The upload could not be completed."));
      const skipped = Number(done.body["skipped"]);
      const notes = [
        skipped > 0 ? ` ${String(skipped)} macOS metadata entries (__MACOSX, .DS_Store, ._ files) were skipped.` : "",
        done.body["hostsSynced"] === true ? "" : " Not every domain could be switched yet; this is retried within minutes.",
      ].join("");
      setPhase({ kind: "done", message: `Version ${String(done.body["version"])} is live.${notes}` });
      router.refresh();
    } catch (failure) {
      setPhase({ kind: "error", message: failure instanceof Error ? failure.message : "The upload failed. Check the connection and try again." });
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (file.size > MAX_BYTES) {
      setPhase({ kind: "error", message: "The ZIP is larger than 25 MB." });
      return;
    }
    void send(file);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lp-zip-upload">
      <Label htmlFor={id}>Upload a new version (ZIP, up to 25 MB)</Label>
      <input
        id={id}
        type="file"
        accept=".zip,application/zip"
        onChange={onChange}
        disabled={phase.kind === "sending"}
        className="max-w-full text-sm file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:text-on-secondary"
      />
      {phase.kind === "sending" ? (
        <p role="status" className="text-sm">
          {phase.sent < phase.total ? `Uploading... ${String(Math.floor((phase.sent / Math.max(phase.total, 1)) * 100))}%` : "Checking and publishing..."}
        </p>
      ) : null}
      {phase.kind === "done" ? (
        <p role="status" className="text-sm">
          {phase.message}
        </p>
      ) : null}
      {phase.kind === "error" ? <FormError>{phase.message}</FormError> : null}
      {phase.kind === "rejected" ? (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm" data-testid="lp-zip-issues">
          <p className="font-medium">The ZIP was refused and nothing was published. Fix these and upload it again:</p>
          <ul className="flex flex-col gap-0.5">
            {phase.issues.map((issue, i) => (
              <li key={`${String(i)}-${issue.code}`}>
                {issue.entry === null ? null : <span className="font-mono break-all">{issue.entry}: </span>}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
