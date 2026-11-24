"use client";

// Template editor (US-017): Save stores the text (checked on the server); Preview renders the text
// in the form, unsaved, with sample values. A WhatsApp preview is plain text (React escapes it); an
// e-mail preview is an HTML document shown in an iframe with an empty sandbox (no scripts, no
// forms, a unique origin) and its own CSP, so nothing in a template can run in the console.
import { type SubmitEvent as ReactSubmitEvent, startTransition, useActionState } from "react";
import { Button } from "@ebooktrivia/ui/components/button";
import { INITIAL_PREVIEW, INITIAL_SAVE, type PreviewState, type SaveState } from "../../../../lib/form-state.ts";
import { FormError } from "../../../../components/auth/auth-card.tsx";
import { TextArea, TextField } from "../../../../components/settings/fields.tsx";

export function TemplateEditor({
  template,
  save,
  previewAction,
}: {
  template: { readonly id: string; readonly channel: "whatsapp" | "email"; readonly subject: string | null; readonly body: string };
  save: (previous: SaveState, form: FormData) => Promise<SaveState>;
  previewAction: (previous: PreviewState, form: FormData) => Promise<PreviewState>;
}) {
  const [saved, dispatchSave, saving] = useActionState(save, INITIAL_SAVE);
  const [shown, dispatchPreview, previewing] = useActionState(previewAction, INITIAL_PREVIEW);
  const onSubmit = (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = event.nativeEvent.submitter;
    const data = new FormData(event.currentTarget);
    startTransition(() => {
      if (submitter instanceof HTMLButtonElement && submitter.value === "preview") dispatchPreview(data);
      else dispatchSave(data);
    });
  };
  const prefix = `tpl-${template.id}`;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" data-testid="template-editor">
      <input type="hidden" name="templateId" value={template.id} />
      {template.channel === "email" ? <TextField id={`${prefix}-subject`} name="subject" label="Subject" defaultValue={template.subject} maxLength={200} /> : null}
      <TextArea id={`${prefix}-body`} name="body" label={template.channel === "email" ? "Body (HTML)" : "Text"} defaultValue={template.body} rows={template.channel === "email" ? 10 : 6} />
      <TextField id={`${prefix}-sample`} name="sampleName" label="Sample buyer name (preview only)" required={false} maxLength={100} placeholder="Budi Santoso" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" value="save" variant="cta" size="sm" disabled={saving}>
          Save template
        </Button>
        <Button type="submit" value="preview" variant="outline" size="sm" disabled={previewing}>
          Preview
        </Button>
        {saved.status === "saved" ? (
          <p role="status" className="text-sm" key={saved.at}>
            {saved.message}
          </p>
        ) : null}
      </div>
      {saved.status === "error" ? <FormError key={saved.at}>{saved.error}</FormError> : null}
      {shown.status === "error" ? <FormError key={shown.at}>{shown.error}</FormError> : null}
      {shown.status === "preview" ? (
        <section aria-label="Preview" className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3" data-testid="template-preview">
          {shown.subject === null ? null : (
            <p className="text-sm">
              <span className="font-medium">Subject: </span>
              <span data-testid="preview-subject">{shown.subject}</span>
            </p>
          )}
          {shown.channel === "whatsapp" ? (
            <p className="text-sm whitespace-pre-wrap" data-testid="preview-text">
              {shown.body}
            </p>
          ) : (
            <iframe title="E-mail preview" sandbox="" srcDoc={shown.body} referrerPolicy="no-referrer" className="h-72 w-full rounded-md border bg-white" data-testid="preview-frame" />
          )}
          {shown.note === null ? null : (
            <p className="text-xs text-muted-foreground" data-testid="preview-note">
              {shown.note}
            </p>
          )}
        </section>
      ) : null}
    </form>
  );
}
