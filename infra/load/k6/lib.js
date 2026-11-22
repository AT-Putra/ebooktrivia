// Pure helpers shared by the k6 scripts (no k6 imports, so vitest can load this file: src/k6-lib.test.ts).

/**
 * Indonesian mobile numbers of the form +62812 + 8 digits: unique for every i of a run, whatever the run seed.
 * @param {number} runSeed
 * @param {number} i
 * @returns {string}
 */
export function phoneFor(runSeed, i) {
  const span = 89_999_999; // 10_000_000 .. 99_999_999
  return `+62812${String(10_000_000 + ((runSeed + i) % span))}`;
}

/**
 * The buyer of order number i: name, phone, e-mail on the operator's own domain, and a click id of the adnet.
 * @param {number} runSeed
 * @param {string} runTag
 * @param {number} i
 * @param {string} emailDomain
 * @returns {{ name: string, phone: string, email: string, clickid: string }}
 */
export function buyerFor(runSeed, runTag, i, emailDomain) {
  return {
    name: `Load Tester ${runTag} ${i}`,
    phone: phoneFor(runSeed, i),
    email: `lt${runTag}.${i}@${emailDomain}`,
    clickid: `lt${runTag}x${i}`,
  };
}

/**
 * A whole number in [min, max] (inclusive) from a uniform random in [0, 1).
 * @param {number} min
 * @param {number} max
 * @param {number} random
 * @returns {number}
 */
export function between(min, max, random) {
  return min + Math.floor(random * (max - min + 1));
}
