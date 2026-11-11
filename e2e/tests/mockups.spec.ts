import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ROUTES, urlFor, VIEWPORTS, type MockupRoute } from "../routes.ts";

const SHOT_DIR = fileURLToPath(new URL("../../docs/mockups/", import.meta.url));
mkdirSync(SHOT_DIR, { recursive: true });

/** Fonts loaded, grid stagger (<= ~800 ms) finished, network idle. */
async function settle(page: Page, route: MockupRoute): Promise<void> {
  await page.waitForLoadState("networkidle");
  if (route.light === true) {
    await page.getByRole("button", { name: /theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "admin-light");
  }
  await page.evaluate(() => document.fonts.ready);
  // Trigger lazy images so full-page screenshots show the real art.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
  });
  await page.waitForTimeout(1200);
}

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`${route.slug} @${viewport.width}: renders, screenshot, axe has no serious/critical violations`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const response = await page.goto(urlFor(route));
      expect(response?.status()).toBe(200);
      await settle(page, route);

      // No horizontal scroll at any width (CLS/overflow guard).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);

      await page.screenshot({ path: `${SHOT_DIR}${route.slug}-${viewport.width}.png`, fullPage: true });

      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(
        blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) })),
      ).toEqual([]);
    });
  }
}

test.describe("trivia page structure", () => {
  const trivia = ROUTES.find((r) => r.slug === "trivia");
  if (trivia === undefined) throw new Error("trivia route missing");

  test("the 4 cards are in the DOM in reading order: banner, leaderboard, profile, grid", async ({ page }) => {
    await page.goto(urlFor(trivia));
    const order = await page.evaluate(() =>
      [...document.querySelectorAll("main section[aria-labelledby]")].map((s) => s.getAttribute("aria-labelledby")),
    );
    expect(order).toEqual(["banner-title", "leaderboard-title", "profile-title", "grid-title"]);
  });

  test("desktop placement never reorders: visual order is row-major 1-2-3-4", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(urlFor(trivia));
    await page.waitForLoadState("networkidle");
    const boxes = await page.evaluate(() =>
      ["banner-title", "leaderboard-title", "profile-title", "grid-title"].map((id) => {
        const rect = document.querySelector(`section[aria-labelledby="${id}"]`)?.getBoundingClientRect();
        return rect === undefined ? null : { top: rect.top, left: rect.left };
      }),
    );
    const [banner, leaderboard, profile, grid] = boxes;
    if (!banner || !leaderboard || !profile || !grid) throw new Error("missing card");
    expect(leaderboard.top).toBeGreaterThan(banner.top);
    expect(profile.top).toBeGreaterThanOrEqual(leaderboard.top - 1);
    expect(profile.left).toBeGreaterThan(leaderboard.left);
    expect(grid.top).toBeGreaterThan(Math.max(leaderboard.top, profile.top));
  });

  test("exactly 4 cards", async ({ page }) => {
    await page.goto(urlFor(trivia));
    await expect(page.locator("main section[aria-labelledby]")).toHaveCount(4);
  });
});

test.describe("prefers-reduced-motion", () => {
  test.use({ reducedMotion: "reduce" });

  const paths = ["/mockups/trivia", "/mockups/trivia/play", "/mockups/trivia/play?state=correct", "/mockups/order/paid"];

  for (const path of paths) {
    test(`no CSS animation or transition runs on ${path}`, async ({ page }) => {
      await page.goto(`http://127.0.0.1:3100${path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);

      const result = await page.evaluate(() => {
        const toMs = (value: string) =>
          value
            .split(",")
            .map((v) => v.trim())
            .map((v) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000));
        const offenders: string[] = [];
        for (const el of document.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          const longest = Math.max(...toMs(cs.transitionDuration), ...toMs(cs.animationDuration));
          if (Number.isFinite(longest) && longest > 1) offenders.push(`${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 40)} ${longest}ms`);
        }
        const running = document.getAnimations().filter((a) => a.playState === "running").length;
        return { offenders, running, matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches };
      });

      expect(result.matches).toBe(true);
      expect(result.offenders).toEqual([]);
      expect(result.running).toBe(0);
    });
  }
});

test.describe("play demo interaction", () => {
  test("a tap locks the answer, reveals the explanation and Lanjut advances", async ({ page }) => {
    await page.goto("http://127.0.0.1:3100/mockups/trivia/play");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Candi Prambanan/ }).click();
    await expect(page.getByText("Jawabanmu salah. +0 poin")).toBeVisible();
    await expect(page.getByText("Jawaban benar")).toBeVisible();
    await expect(page.getByText("Penjelasan")).toBeVisible();
    // Locked: a second tap changes nothing.
    await page.getByRole("button", { name: /Candi Mendut/ }).click({ force: true });
    await expect(page.getByText("Jawabanmu salah. +0 poin")).toBeVisible();
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByText("Soal 2 dari 3").first()).toBeVisible();
  });
});
