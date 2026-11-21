// Runs in every worker int file (vitest.int.config.ts setupFiles). Registered first, so it runs after the file's own afterAll
// hooks (vitest runs after-hooks in reverse order): every worker, queue and harness process is closed before the keys of its
// prefixes are removed.
import { afterAll } from "vitest";
import { removeUsedPrefixes } from "./valkey.ts";

afterAll(removeUsedPrefixes);
