import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/health/route";

describe("GET /health", () => {
  it("returns ok: true", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
