// The message id of an incoming WhatsApp message, sealed for the read marks (Owner rule 2026-11-24; apps/worker/src/delivery/read-marks.ts). A WAHA message id embeds the
// sender's chat id (`false_<digits>@c.us_<key>`), so it is personal data, strangers' included; the public webhook hands it to the worker through Valkey, which keeps an AOF
// on disk beyond the ring's ten minutes. So the id is never written in clear there: it is sealed to the MESSAGING public key (the same X25519 sealed box and keys as the OTP
// codes) and only the worker, which holds the private key, opens it.
//
//   sealed = seal(messaging public key, message id, waReadAad(session, digest))      48 bytes of overhead + the id
//
// The AAD binds the blob to the session and to the chat's digest (the keyed digest the webhook uses as the chat's key): a blob moved to another item, session or chat does
// not open. A separate small API (not a method of SecretSealer / SecretOpener, whose shape other apps pin) over the same primitives.
import { canonicalAad } from "./aad.ts";
import { CryptoError, open, privateKeyObject, publicKeyObject, seal, SEALED_BOX_OVERHEAD } from "./sealed-box.ts";
import { type Env, scopeKeysFromEnv } from "./secrets.ts";

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{32}$/;
/** What a WAHA message id is made of: `true|false_<chat id>_<key>`. */
const MESSAGE_ID = /^[A-Za-z0-9@._-]{1,128}$/;
/** The longest a sealed id can be: 128 bytes of id and the box's overhead. */
export const WA_READ_SEALED_MAX_BYTES = 128 + SEALED_BOX_OVERHEAD;

export interface WaReadLabels {
  /** The WAHA session (pool number) the message arrived on. */
  readonly session: string;
  /** The chat's keyed digest (32 lowercase hex). */
  readonly digest: string;
}

const invalid = (what: string): CryptoError => new CryptoError("invalid_input", what);

export function waReadAad(labels: WaReadLabels): Buffer {
  if (!SESSION.test(labels.session)) throw invalid("session must be a WAHA session name");
  if (!DIGEST.test(labels.digest)) throw invalid("digest must be 32 lowercase hex characters");
  return canonicalAad(["wa_read", "message_id", labels.session, labels.digest]);
}

export interface WaReadSealer {
  /** The sealed message id (opaque bytes). */
  seal(input: WaReadLabels & { readonly messageId: string }): Buffer;
}

export interface WaReadOpener {
  /** The message id of a sealed one; CryptoError decrypt_failed for anything else (another key, session or digest, a flipped byte). */
  open(input: WaReadLabels & { readonly sealed: Uint8Array }): string;
}

export function createWaReadSealer(messagingPublicKey: Uint8Array): WaReadSealer {
  publicKeyObject(messagingPublicKey); // validates the length
  // A low-order key would make every seal fail; refuse it at startup instead (as createSecretSealer does).
  seal(messagingPublicKey, Buffer.alloc(0), Buffer.alloc(0));
  const key = Buffer.from(messagingPublicKey);
  return Object.freeze({
    seal(input: WaReadLabels & { readonly messageId: string }): Buffer {
      if (typeof input.messageId !== "string" || !MESSAGE_ID.test(input.messageId)) throw invalid("message id must be a WAHA message id");
      return seal(key, Buffer.from(input.messageId, "ascii"), waReadAad(input));
    },
  });
}

export function createWaReadOpener(messagingPrivateKey: Uint8Array): WaReadOpener {
  const key = privateKeyObject(messagingPrivateKey);
  return Object.freeze({
    open(input: WaReadLabels & { readonly sealed: Uint8Array }): string {
      const aad = waReadAad(input);
      if (input.sealed.length <= SEALED_BOX_OVERHEAD || input.sealed.length > WA_READ_SEALED_MAX_BYTES) throw new CryptoError("decrypt_failed", "decryption failed");
      const messageId = open(key, input.sealed, aad).toString("latin1");
      if (!MESSAGE_ID.test(messageId)) throw new CryptoError("decrypt_failed", "decryption failed");
      return messageId;
    },
  });
}

/** The sealer from SECRETS_MESSAGING_PUBLIC_KEY (public.env); undefined when it is not set. A malformed key throws. */
export function waReadSealerFromEnv(env: Env): WaReadSealer | undefined {
  const key = scopeKeysFromEnv(env, "PUBLIC").messaging;
  return key === undefined ? undefined : createWaReadSealer(key);
}

/** The opener from SECRETS_MESSAGING_PRIVATE_KEY (worker.env); undefined when it is not set. A malformed key throws. */
export function waReadOpenerFromEnv(env: Env): WaReadOpener | undefined {
  const key = scopeKeysFromEnv(env, "PRIVATE").messaging;
  return key === undefined ? undefined : createWaReadOpener(key);
}
