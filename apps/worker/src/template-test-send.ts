// Template test-send consumer (AC-A10, plan M2.3 "admin test-send runs as a worker job"; US-017).
// The admin console writes a template_test_sends row and an outbox row (topic template.test_send,
// payload { test_send_id }); only this worker sends, with the messaging private key.
//
//   perform  claims the test-send (pending -> sending; no row = already handled: a no-op), renders
//            the STORED template with fixed sample values through core's redacted renderer
//            ({kode_otp} / {link_trivia} appear as [kode_otp] / [link_trivia]: never a real login
//            code or link), prefixed "[UJI]", and sends it through the injected sender.
//   finalize records sent, or failed with a short error code (no provider text, no PII). Either
//            way the outbox row is processed: a test-send is never retried.
// The effect row gives at-most-once: a crash after the claim leaves the test-send `sending`, and
// a re-claim of the outbox row finds nothing pending (outbox-consumer.ts contract).
import { isUuid, renderMessageRedacted, TemplateError, TEST_SEND_SAMPLE_VALUES, TEST_SEND_TOPIC } from "@ebooktrivia/core";
import type postgres from "postgres";
import type { FinalizeWrites, OutboxConsumer } from "./outbox-consumer.ts";

// The topic and the sample values are core's, shared with the console's preview (code review US-017 L5).
export { TEST_SEND_TOPIC };
export const TEST_SEND_VALUES = TEST_SEND_SAMPLE_VALUES;

export interface TestEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface TestSender {
  email(message: TestEmail, signal: AbortSignal): Promise<void>;
  whatsapp(message: { readonly sessionId: string; readonly to: string; readonly text: string }, signal: AbortSignal): Promise<void>;
}

/** A send failure the worker records as-is (the code only: ^[a-z_]{1,64}$). */
export class TestSendError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`test-send failed: ${code}`);
    this.name = "TestSendError";
    this.code = /^[a-z_]{1,64}$/.test(code) ? code : "send_failed";
  }
}


interface Claimed {
  readonly id: string;
  readonly channel: "whatsapp" | "email";
  readonly recipient: string;
  readonly waha_session_id: string | null;
  readonly subject: string | null;
  readonly body: string;
}

function render(claimed: Claimed): { readonly subject: string; readonly body: string } {
  if (claimed.channel === "whatsapp") return { subject: "", body: `[UJI] ${renderMessageRedacted(claimed.body, "whatsapp", TEST_SEND_VALUES)}` };
  return {
    subject: `[UJI] ${renderMessageRedacted(claimed.subject ?? "", "email_subject", TEST_SEND_VALUES)}`,
    body: renderMessageRedacted(claimed.body, "email_html", TEST_SEND_VALUES),
  };
}

export function createTemplateTestSendConsumer(deps: { readonly sql: postgres.Sql; readonly sender: TestSender; readonly leaseMs?: number }): OutboxConsumer {
  return {
    topic: TEST_SEND_TOPIC,
    leaseMs: deps.leaseMs ?? 60_000,
    async perform(row, signal): Promise<FinalizeWrites | undefined> {
      // outbox.payload is always a JSON object (outbox_payload_check).
      const id = (row.payload as Record<string, unknown>)["test_send_id"];
      if (!isUuid(id)) throw new Error("template.test_send payload has no valid test_send_id");
      const [claimed] = await deps.sql<Claimed[]>`
        WITH claimed AS (
          UPDATE public.template_test_sends SET status = 'sending', updated_at = now()
           WHERE id = ${id} AND status = 'pending'
          RETURNING id, template_id, channel, recipient, waha_session_id)
        SELECT c.id, c.channel, c.recipient, c.waha_session_id, t.subject, t.body
          FROM claimed c JOIN public.message_templates t ON t.id = c.template_id`;
      if (claimed === undefined) return undefined;
      let error: string | null = null;
      try {
        const message = render(claimed);
        if (claimed.channel === "whatsapp") {
          if (claimed.waha_session_id === null) throw new TestSendError("no_session");
          await deps.sender.whatsapp({ sessionId: claimed.waha_session_id, to: claimed.recipient, text: message.body }, signal);
        } else {
          await deps.sender.email({ to: claimed.recipient, subject: message.subject, html: message.body, text: "Pesan uji template email (lihat versi HTML)." }, signal);
        }
      } catch (failure) {
        error = failure instanceof TestSendError ? failure.code : failure instanceof TemplateError ? "render_failed" : "send_failed";
      }
      return async (tx) => {
        if (error === null) {
          await tx`UPDATE public.template_test_sends SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = ${claimed.id} AND status = 'sending'`;
        } else {
          await tx`UPDATE public.template_test_sends SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${claimed.id} AND status = 'sending'`;
        }
      };
    },
  };
}
