// The fields of an ad-spend entry (create and edit share them): a plain form body, ids prefixed per form.
import { SelectField, TextField } from "../settings/fields.tsx";
import { Label } from "@ebooktrivia/ui/components/label";
import { AD_PLATFORM_LABELS, AD_PLATFORMS } from "../../lib/reports/ad-spend.ts";

interface Choice {
  readonly id: string;
  readonly name: string;
}

export interface AdSpendCurrent {
  readonly spendDate: string;
  readonly platform: string;
  readonly landingPageId: string | null;
  readonly adnetId: string | null;
  readonly utmCampaign: string | null;
  readonly amountIdr: number;
  readonly note: string | null;
}

const CONTROL =
  "min-h-11 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base text-card-foreground focus-visible:border-ring focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring";

function OptionalSelect({ id, name, label, value, choices, none }: { id: string; name: string; label: string; value: string | null; choices: readonly Choice[]; none: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} defaultValue={value ?? ""} className={CONTROL}>
        <option value="">{none}</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AdSpendFields({ idPrefix, today, landingPages, adnets, current }: { idPrefix: string; today: string; landingPages: readonly Choice[]; adnets: readonly Choice[]; current?: AdSpendCurrent }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField id={`${idPrefix}-date`} name="spend_date" label="Date" type="date" defaultValue={current?.spendDate ?? today} />
      <SelectField id={`${idPrefix}-platform`} name="platform" label="Platform" defaultValue={current?.platform ?? "meta"} options={AD_PLATFORMS.map((p) => ({ value: p, label: AD_PLATFORM_LABELS[p] }))} />
      <OptionalSelect id={`${idPrefix}-lp`} name="landing_page_id" label="Landing page (optional)" value={current?.landingPageId ?? null} choices={landingPages} none="Not assigned" />
      <OptionalSelect id={`${idPrefix}-adnet`} name="adnet_id" label="Adnet (optional)" value={current?.adnetId ?? null} choices={adnets} none="No adnet (Organic)" />
      <TextField id={`${idPrefix}-campaign`} name="utm_campaign" label="Campaign (optional)" defaultValue={current?.utmCampaign ?? ""} required={false} maxLength={256} hint="The utm_campaign of the ads." />
      <TextField
        id={`${idPrefix}-amount`}
        name="amount_idr"
        label="Amount (Rp)"
        type="text"
        inputMode="numeric"
        defaultValue={current === undefined ? "" : String(current.amountIdr)}
        hint="Whole rupiah, e.g. 1250000."
      />
      <div className="sm:col-span-2">
        <TextField id={`${idPrefix}-note`} name="note" label="Note (optional)" defaultValue={current?.note ?? ""} required={false} maxLength={200} hint="No personal data." />
      </div>
    </div>
  );
}
