import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_URL_ENV, databaseUrl } from "../../src/index";

describe("databaseUrl", () => {
  const previous = process.env[DATABASE_URL_ENV];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[DATABASE_URL_ENV];
    } else {
      process.env[DATABASE_URL_ENV] = previous;
    }
  });

  it("throws a helpful error when DATABASE_URL is unset", () => {
    delete process.env[DATABASE_URL_ENV];
    expect(() => databaseUrl()).toThrowError(/DATABASE_URL/);
  });

  it("returns the configured URL", () => {
    process.env[DATABASE_URL_ENV] = "postgresql://localhost:5432/test";
    expect(databaseUrl()).toBe("postgresql://localhost:5432/test");
  });
});
