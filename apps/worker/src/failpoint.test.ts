import { describe, expect, it, vi } from "vitest";
import { createFailpoint, FAILPOINTS } from "./failpoint.ts";

describe("failpoints", () => {
  it("fire only the armed point outside production", () => {
    const kill = vi.fn();
    const failpoint = createFailpoint({ nodeEnv: "test", failpoint: "conversion_after_fire" }, kill);
    failpoint("conversion_after_claim");
    expect(kill).not.toHaveBeenCalled();
    failpoint("conversion_after_fire");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("are inert when nothing is armed", () => {
    const kill = vi.fn();
    const failpoint = createFailpoint({ nodeEnv: "development", failpoint: undefined }, kill);
    for (const name of FAILPOINTS) failpoint(name);
    expect(kill).not.toHaveBeenCalled();
  });

  it("are inert in production even when armed", () => {
    const kill = vi.fn();
    for (const armed of FAILPOINTS) {
      const failpoint = createFailpoint({ nodeEnv: "production", failpoint: armed }, kill);
      for (const name of FAILPOINTS) failpoint(name);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});
