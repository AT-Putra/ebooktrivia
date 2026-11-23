"use client";

// The status line after a delete (the card with the form that deleted it is gone, so the form cannot show it). The delete
// action redirects to the page with `?deleted=<what>`; the page maps that to a fixed text and shows it here. Once it is on
// screen the query is dropped from the address (history.replaceState, which Next.js keeps in step with its router), so a
// reload or the next save does not show it again. It runs on every render, not once: a second delete of the same kind
// redirects to the same URL and React keeps this component mounted, so a mount-only effect would leave the query in place.
import { useEffect } from "react";
import { Notice } from "./fields.tsx";

export function DeletedNotice({ text }: { text: string }) {
  useEffect(() => {
    if (window.location.search !== "") window.history.replaceState(null, "", window.location.pathname);
  });
  return (
    <div role="status">
      <Notice tone="info" testId="deleted-notice">
        {text}
      </Notice>
    </div>
  );
}
