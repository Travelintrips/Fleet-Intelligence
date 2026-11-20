import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const startup=readFileSync(resolve(process.cwd(),"src/index.ts"),"utf8");

describe("Fleet isolated QA must never run background work",()=>{
  it("honors the disable flag before any leader-lock timer is scheduled",()=>{
    expect(startup).toContain('process.env.DISABLE_BACKGROUND_SCHEDULERS === "true"');
    expect(startup).toContain("const leaderRetryTimer = backgroundSchedulersDisabled");
    expect(startup).toContain("if (!backgroundSchedulersDisabled)");
    expect(startup).toContain("if (leaderRetryTimer) clearInterval(leaderRetryTimer)");
  });
});
