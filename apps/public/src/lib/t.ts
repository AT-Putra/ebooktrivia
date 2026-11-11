import { messages } from "@ebooktrivia/i18n";

type Catalog = typeof messages.id;
type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Paths<Catalog>;

function lookup(tree: unknown, key: string): string {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") throw new Error(`missing message: ${key}`);
    node = Reflect.get(node, part);
  }
  if (typeof node !== "string") throw new Error(`missing message: ${key}`);
  return node;
}

/** Buyer-facing translator (Bahasa Indonesia). Params replace {name} placeholders. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = lookup(messages.id, key);
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
