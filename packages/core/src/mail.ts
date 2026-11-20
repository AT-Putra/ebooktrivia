// Mail address, display-name and attachment-name rules shared by the SMTP adapter (what it sends)
// and the admin console (what it accepts), so the console never stores a value the worker would
// refuse (code review US-017 L5; security review US-012 M2 for the rules themselves).

const LOCAL_PART = /^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const CONTROL = /\p{Cc}/u;
const DISPLAY_NAME = /^[^<>"\\,;:@()[\]]{1,64}$/u;
const FILENAME = /^[^"'\\/<>:*?|]{1,128}$/u;

/** True for one plain ASCII addr-spec ("local@domain.tld"): no display name, quotes, comma or CR/LF. */
export function isPlainAddress(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && LOCAL_PART.test(local) && DOMAIN.test(domain);
}

/** A sender display name: up to 64 characters, no specials that would need quoting, no controls. */
export function isSafeDisplayName(value: string): boolean {
  return DISPLAY_NAME.test(value) && !CONTROL.test(value);
}

/** An attachment / stored file name: 1-128 characters, no path or quoting characters, no controls, no leading dot. */
export function isSafeFileName(value: string): boolean {
  return FILENAME.test(value) && !CONTROL.test(value) && !value.startsWith(".");
}
