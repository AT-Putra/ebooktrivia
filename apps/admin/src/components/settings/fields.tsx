// Plain form controls of the settings pages (US-017): every control has a visible, associated
// label; ids are prefixed per form, as several forms share field names on one page.
import type { ReactNode } from "react";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Input } from "@ebooktrivia/ui/components/input";
import { Label } from "@ebooktrivia/ui/components/label";
import type { SecretStatus } from "../../lib/settings/secrets.ts";

const CONTROL =
  "min-h-11 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base text-card-foreground focus-visible:border-ring focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

export function TextField({
  id,
  name,
  label,
  defaultValue,
  hint,
  type = "text",
  required = true,
  disabled = false,
  readOnly = false,
  maxLength,
  placeholder,
  inputMode,
  autoComplete = "off",
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | number | null | undefined;
  hint?: string | undefined;
  type?: "text" | "date" | "email" | "url" | "number" | "password" | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Shown and submitted, not editable (locked program fields). */
  readOnly?: boolean | undefined;
  maxLength?: number | undefined;
  placeholder?: string | undefined;
  inputMode?: "numeric" | "decimal" | "tel" | "email" | "url" | undefined;
  autoComplete?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        maxLength={maxLength}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  id,
  name,
  label,
  defaultValue,
  rows = 6,
  hint,
  maxLength,
  minLength,
  required = false,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | null | undefined;
  rows?: number | undefined;
  hint?: string | undefined;
  maxLength?: number;
  minLength?: number;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ""}
        maxLength={maxLength}
        minLength={minLength}
        required={required}
        className={`${CONTROL} font-mono text-sm`}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  id,
  name,
  label,
  options,
  defaultValue,
  disabled = false,
}: {
  id: string;
  name: string;
  label: string;
  options: readonly { readonly value: string; readonly label: string }[];
  defaultValue?: string | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} defaultValue={defaultValue} disabled={disabled} className={CONTROL} required>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckboxField({ id, name, label, defaultChecked, hint }: { id: string; name: string; label: string; defaultChecked?: boolean | undefined; hint?: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <input id={id} name={name} type="checkbox" defaultChecked={defaultChecked} className="mt-1 size-4 accent-primary" />
      <div className="flex flex-col">
        <Label htmlFor={id}>{label}</Label>
        {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

/** "Set (ends in abcd)" or "Not set": the only thing the console ever shows of a secret. */
export function SecretBadge({ status, testId }: { status: SecretStatus; testId?: string }) {
  if (!status.set) {
    return (
      <Badge variant="warning" data-testid={testId}>
        Not set
      </Badge>
    );
  }
  return (
    <Badge variant="success" data-testid={testId}>
      {status.last4 === "" ? "Set" : `Set, ends in ${status.last4}`}
    </Badge>
  );
}

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** A one-line state banner of a settings page (US-018): locked content, final results. */
export function Notice({ tone, children, testId }: { tone: "warning" | "info"; children: ReactNode; testId?: string }) {
  const colors = tone === "warning" ? "border-warning/60 bg-warning-soft text-warning-soft-foreground" : "border-info/60 bg-info-soft text-info-soft-foreground";
  return (
    <p className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${colors}`} data-testid={testId}>
      {children}
    </p>
  );
}
