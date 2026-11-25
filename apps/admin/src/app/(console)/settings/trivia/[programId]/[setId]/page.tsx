import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircleIcon, LockIcon } from "@phosphor-icons/react/ssr";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../../../components/settings/action-form.tsx";
import { CheckboxField, Notice, PageHeading, SelectField, TextArea, TextField } from "../../../../../../components/settings/fields.tsx";
import { UploadFile } from "../../../../../../components/settings/upload-file.tsx";
import { requireAdmin } from "../../../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../../../lib/next/runtime.ts";
import { can } from "../../../../../../lib/policy.ts";
import { OVERRIDE_BLOCKED } from "../../../../../../lib/settings/rescore.ts";
import { IMPORT_COLUMNS, IMPORT_MAX_ROWS, IMPORT_TEMPLATE_CSV } from "../../../../../../lib/settings/trivia-import-format.ts";
import { getSet, getTriviaProgram, LOCKED_SET, type QuestionView, TRIVIA_LIMITS } from "../../../../../../lib/settings/trivia.ts";
import { createQuestionAction, deleteQuestionAction, overrideScoringAction, removeQuestionImageAction, updateQuestionAction } from "../../actions.ts";

export const metadata: Metadata = { title: "Trivia questions | Admin Console" };

/** With a UTF-8 byte order mark, so spreadsheet apps read the CSV as UTF-8. */
const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(String.fromCharCode(0xfeff) + IMPORT_TEMPLATE_CSV)}`;
const POSITIONS = [1, 2, 3, 4] as const;

interface Ids {
  readonly programId: string;
  readonly setId: string;
}

function Hidden({ ids, questionId }: { ids: Ids; questionId?: string }) {
  return (
    <>
      <input type="hidden" name="programId" value={ids.programId} />
      <input type="hidden" name="setId" value={ids.setId} />
      {questionId === undefined ? null : <input type="hidden" name="questionId" value={questionId} />}
    </>
  );
}

/** Prompt, options, explanation; and when `scoring`, the correct option, points and timer. */
function QuestionFields({ prefix, question, defaults, scoring }: { prefix: string; question?: QuestionView; defaults: { points: number; timer: number }; scoring: boolean }) {
  const count = question?.options.length ?? 4;
  const positions = scoring ? POSITIONS : POSITIONS.filter((p) => p <= count);
  const correct = question?.options.find((o) => o.isCorrect)?.position ?? 1;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <TextArea id={`${prefix}-prompt`} name="prompt" label="Question" rows={2} defaultValue={question?.prompt} maxLength={TRIVIA_LIMITS.prompt} />
      </div>
      {positions.map((p) => (
        <TextField
          key={p}
          id={`${prefix}-option${String(p)}`}
          name={`option${String(p)}`}
          label={`Option ${String(p)}`}
          defaultValue={question?.options.find((o) => o.position === p)?.label}
          maxLength={TRIVIA_LIMITS.option}
          required={p <= 2 || !scoring}
          hint={scoring && p > 2 ? "Optional." : undefined}
        />
      ))}
      {scoring ? (
        <>
          <SelectField id={`${prefix}-correct`} name="correct" label="Correct option" options={POSITIONS.map((p) => ({ value: String(p), label: `Option ${String(p)}` }))} defaultValue={String(correct)} />
          <TextField id={`${prefix}-points`} name="points" label="Points" type="number" inputMode="numeric" defaultValue={question?.points ?? defaults.points} />
          <TextField id={`${prefix}-timer`} name="timerSeconds" label="Timer (seconds)" type="number" inputMode="numeric" defaultValue={question?.timerSeconds ?? defaults.timer} />
        </>
      ) : null}
      <div className="sm:col-span-2">
        <TextArea id={`${prefix}-explanation`} name="explanation" label="Explanation (optional, shown after a wrong pick)" rows={2} defaultValue={question?.explanation} maxLength={TRIVIA_LIMITS.explanation} />
      </div>
    </div>
  );
}

function QuestionSummary({ question }: { question: QuestionView }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="whitespace-pre-line">{question.prompt}</p>
      <ol className="flex flex-col gap-0.5 pl-1">
        {question.options.map((o) => (
          <li key={o.id} className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{o.position}.</span>
            {o.label}
            {o.isCorrect ? <CheckCircleIcon aria-label="correct" weight="fill" className="text-success" /> : null}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {question.points} points · {question.timerSeconds} s{question.imageUploadId === null ? "" : " · image set"}
        {question.explanation === null ? "" : " · has an explanation"}
      </p>
    </div>
  );
}

/** A set's questions: editor, CSV / XLSX import, and the Owner's scoring override once locked. */
export default async function TriviaQuestionsPage({ params }: { params: Promise<{ programId: string; setId: string }> }) {
  const admin = await requireAdmin({ permission: "trivia_set.edit" });
  const { programId, setId } = await params;
  if (!isUuid(programId) || !isUuid(setId)) notFound();
  const { sql } = await getRuntime();
  const [program, set] = await Promise.all([getTriviaProgram(sql, programId), getSet(sql, programId, setId)]);
  if (program === null || set === null) notFound();
  const ids = { programId, setId };
  const locked = set.attempts > 0;
  const editable = can(admin.role, "question.content.edit", { setLocked: locked });
  const importable = can(admin.role, "question.import", { setLocked: locked }) && !locked;
  const override = locked && can(admin.role, "rescore.override") && !program.snapshot;
  const defaults = { points: program.defaultPoints, timer: program.defaultTimerSeconds };
  return (
    <>
      <p className="flex flex-wrap gap-1 text-sm">
        <Link href="/settings/trivia" className="underline underline-offset-4">
          Trivia
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/settings/trivia/${programId}`} className="underline underline-offset-4">
          {program.name}
        </Link>
      </p>
      <PageHeading title={set.title} description={`${String(set.questionCount)} question${set.questionCount === 1 ? "" : "s"}. Players see the questions and the options in a shuffled order.`} />
      {locked ? (
        <Notice tone="warning" testId="set-locked">
          <LockIcon aria-hidden="true" className="mt-0.5 shrink-0" />
          {editable ? LOCKED_SET : `This set has ${String(set.attempts)} attempt${set.attempts === 1 ? "" : "s"}: it is locked, and only the Owner can change it.`}
        </Notice>
      ) : null}
      {locked && program.snapshot ? <Notice tone="info" testId="override-blocked">{OVERRIDE_BLOCKED}</Notice> : null}

      {editable && !locked ? (
        <Card>
          <CardTitle className="text-base">New question</CardTitle>
          <ActionForm action={createQuestionAction} submitLabel="Add question" testId="question-create">
            <Hidden ids={ids} />
            <QuestionFields prefix="new" defaults={defaults} scoring />
          </ActionForm>
        </Card>
      ) : null}

      {importable ? (
        <Card data-testid="question-import">
          <CardTitle className="text-base">Import questions (CSV or XLSX)</CardTitle>
          <CardDescription>
            Columns, in this order with this header row: {IMPORT_COLUMNS.join(", ")}. 2 to 4 options; correct is the option number; empty points or timer take the defaults ({defaults.points} points,{" "}
            {defaults.timer} s). Up to {IMPORT_MAX_ROWS} questions per file; images are added per question afterwards. Formula cells are refused: paste values. If any row is invalid,
            nothing is imported and every bad row is listed.
          </CardDescription>
          <a href={TEMPLATE_HREF} download="question-template.csv" className="w-fit text-sm underline underline-offset-4" data-testid="import-template">
            Download the template (CSV)
          </a>
          <UploadFile id="question-import-file" url={`/uploads/questions?program=${programId}&set=${setId}`} label="Questions file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" mode="import" />
        </Card>
      ) : null}

      {set.questions.length === 0 ? (
        <Card>
          <CardDescription>No question yet.</CardDescription>
        </Card>
      ) : null}
      {set.questions.map((question, index) => (
        <Card key={question.id} data-testid={`question-${String(index + 1)}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Question {index + 1}</CardTitle>
            <Badge variant="secondary">
              {question.points} points · {question.timerSeconds} s
            </Badge>
          </div>
          {editable ? (
            <>
              <ActionForm action={updateQuestionAction} submitLabel={locked ? "Save text" : "Save question"} variant="secondary" testId="question-edit">
                <Hidden ids={ids} questionId={question.id} />
                {locked ? <p className="text-xs text-muted-foreground">Text only: points, timer and the correct option change through Override scoring below.</p> : null}
                <QuestionFields prefix={`q-${question.id}`} question={question} defaults={defaults} scoring={!locked} />
              </ActionForm>
              <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <UploadFile
                    id={`q-image-${question.id}`}
                    url={`/uploads/image/trivia?program=${programId}&set=${setId}&question=${question.id}`}
                    label={question.imageUploadId === null ? "Image (optional; JPEG, PNG or WebP, up to 2 MB; not shown to players yet)" : "Replace the image (not shown to players yet)"}
                    accept="image/jpeg,image/png,image/webp"
                    mode="image"
                  />
                  {question.imageUploadId === null ? null : (
                    <ActionForm action={removeQuestionImageAction} submitLabel="Remove image" variant="outline">
                      <Hidden ids={ids} questionId={question.id} />
                    </ActionForm>
                  )}
                </div>
                {locked ? null : (
                  <ActionForm action={deleteQuestionAction} submitLabel="Delete question" variant="destructive">
                    <Hidden ids={ids} questionId={question.id} />
                  </ActionForm>
                )}
              </div>
            </>
          ) : (
            <QuestionSummary question={question} />
          )}
          {override ? (
            <details className="rounded-lg border p-3" data-testid="question-override">
              <summary className="cursor-pointer text-sm font-medium">Override scoring (re-scores every player of this set)</summary>
              <ActionForm action={overrideScoringAction} submitLabel="Override and re-score" variant="destructive" className="mt-3 flex flex-col gap-3">
                <Hidden ids={ids} questionId={question.id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectField
                    id={`o-correct-${question.id}`}
                    name="correct"
                    label="Correct option"
                    options={question.options.map((o) => ({ value: String(o.position), label: `${String(o.position)}. ${o.label}` }))}
                    defaultValue={String(question.options.find((o) => o.isCorrect)?.position ?? 1)}
                  />
                  <TextField id={`o-points-${question.id}`} name="points" label="Points" type="number" inputMode="numeric" defaultValue={question.points} />
                  <TextField id={`o-timer-${question.id}`} name="timerSeconds" label="Timer (seconds)" type="number" inputMode="numeric" defaultValue={question.timerSeconds} />
                </div>
                <TextArea
                  id={`o-reason-${question.id}`}
                  name="reason"
                  label="Reason (kept in the audit log)"
                  rows={2}
                  required
                  minLength={10}
                  maxLength={500}
                  hint="Do not include player names or contact details. 10 to 500 characters."
                />
                <p className="text-xs text-muted-foreground">
                  A shorter timer turns an answer given after the new deadline (plus 1.5 s) into a timeout: 0 points, the full timer counted. Restoring the timer restores those answers.
                </p>
                <CheckboxField id={`o-confirm-${question.id}`} name="confirm" label="I understand this changes players' scores and the leaderboard now." />
              </ActionForm>
            </details>
          ) : null}
        </Card>
      ))}
    </>
  );
}
