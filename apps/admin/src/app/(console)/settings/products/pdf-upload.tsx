"use client";

// Chunked PDF upload (US-017; lib/settings/uploads.ts): the file is hashed in the browser, sent in
// 1 MiB chunks (each with its own SHA-256, retried up to 3 times, resumable: `init` returns the
// chunks the server already has), then completed. Over 20 MiB the uploader must confirm the size
// warning first; over the hard cap it is refused before anything is sent. The server checks all of
// this again.
import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ebooktrivia/ui/components/dialog";
import { Label } from "@ebooktrivia/ui/components/label";
import { FormError } from "../../../../components/auth/auth-card.tsx";

const MB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function sha256Hex(data: ArrayBuffer | Blob): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A network failure (no answer): retried like a 5xx. */
const NO_ANSWER: Answer = { ok: false, status: 0, body: {} };

async function post(path: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}

type Phase = { readonly kind: "idle" } | { readonly kind: "confirm"; readonly file: File } | { readonly kind: "uploading"; readonly sent: number; readonly total: number } | { readonly kind: "done"; readonly large: boolean };

export function PdfUpload({ productId, warnBytes, maxBytes }: { productId: string; warnBytes: number; maxBytes: number }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const inputId = `pdf-${productId}`;

  async function upload(file: File, confirmLarge: boolean): Promise<void> {
    setError(null);
    setPhase({ kind: "uploading", sent: 0, total: file.size });
    try {
      const sha256 = await sha256Hex(file);
      const init = await post("/uploads/pdf/init", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId, filename: file.name, size: file.size, sha256, confirmLarge }),
      });
      if (!init.ok) throw new Error(typeof init.body["error"] === "string" ? init.body["error"] : "The upload could not start.");
      const sessionId = String(init.body["sessionId"]);
      const chunkBytes = Number(init.body["chunkBytes"]);
      const chunkCount = Number(init.body["chunkCount"]);
      const receivedList: unknown = init.body["received"];
      const received = new Set(Array.isArray(receivedList) ? receivedList.filter((n): n is number => typeof n === "number") : []);
      let sent = received.size * chunkBytes;
      for (let index = 0; index < chunkCount; index++) {
        if (received.has(index)) continue;
        const chunk = file.slice(index * chunkBytes, Math.min(file.size, (index + 1) * chunkBytes));
        const bytes = await chunk.arrayBuffer();
        const hash = await sha256Hex(bytes);
        let attempt = 0;
        for (;;) {
          const result = await post(`/uploads/pdf/chunk?session=${encodeURIComponent(sessionId)}&index=${String(index)}`, {
            headers: { "content-type": "application/octet-stream", "x-chunk-sha256": hash },
            body: bytes,
          }).catch(() => NO_ANSWER);
          if (result.ok) break;
          attempt++;
          if (attempt >= 3 || (result.status >= 400 && result.status < 500 && result.status !== 409)) {
            throw new Error(typeof result.body["error"] === "string" ? result.body["error"] : "A part of the file could not be sent. Choose the file again to resume.");
          }
        }
        sent = Math.min(file.size, sent + bytes.byteLength);
        setPhase({ kind: "uploading", sent, total: file.size });
      }
      const done = await post(`/uploads/pdf/complete?session=${encodeURIComponent(sessionId)}`, {});
      if (!done.ok) throw new Error(typeof done.body["error"] === "string" ? done.body["error"] : "The upload could not be completed.");
      setPhase({ kind: "done", large: done.body["large"] === true });
      router.refresh();
    } catch (failure) {
      setPhase({ kind: "idle" });
      setError(failure instanceof Error ? failure.message : "The upload failed.");
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (file.size > maxBytes) {
      setError(`This PDF is ${MB(file.size)}; the limit is ${MB(maxBytes)}.`);
      return;
    }
    if (file.size > warnBytes) {
      setPhase({ kind: "confirm", file });
      return;
    }
    void upload(file, false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Upload ebook PDF</Label>
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        onChange={onChange}
        disabled={phase.kind === "uploading"}
        className="text-sm file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:text-on-secondary"
      />
      {phase.kind === "uploading" ? (
        <p role="status" className="text-sm">
          Uploading {MB(phase.sent)} of {MB(phase.total)}...
        </p>
      ) : null}
      {phase.kind === "done" ? (
        <p role="status" className="text-sm">
          PDF uploaded{phase.large ? " (large file: e-mail delivery sends a download link)" : ""}.
        </p>
      ) : null}
      {error === null ? null : <FormError>{error}</FormError>}
      <Dialog
        open={phase.kind === "confirm"}
        onOpenChange={(open) => {
          if (!open) setPhase({ kind: "idle" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Large PDF</DialogTitle>
            <DialogDescription>
              This PDF is {phase.kind === "confirm" ? MB(phase.file.size) : ""}, over {MB(warnBytes)}. Large files are slow to download on mobile data, and e-mail delivery will send a download
              link instead of attaching the file. Upload it anyway?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPhase({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
            <Button
              variant="cta"
              size="sm"
              onClick={() => {
                if (phase.kind === "confirm") void upload(phase.file, true);
              }}
            >
              Upload anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
