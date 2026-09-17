import { describe, expect, it } from "vitest";
import { packageInfo } from "../../src/index";

describe("packageInfo", () => {
  it("identifies the core package", () => {
    expect(packageInfo()).toEqual({ name: "@packsource/core", version: "0.1.0" });
  });
});
