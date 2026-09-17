import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PermissionDeniedError,
  ROLES,
  assertCan,
  can,
  permissionsFor,
  roleSide,
} from "../../src/permissions";

/**
 * The role × action matrix from the spec ("Multi-tenancy and roles"),
 * spelled out literally — deliberately NOT derived from the implementation's
 * PERMISSION_MATRIX, so the test pins the intended grants rather than
 * rubber-stamping whatever the constant says.
 */
const EXPECTED_GRANTS: Record<string, string[]> = {
  // Buyer orgs — OWNER/ADMIN run the workspace; BUYER sources and orders;
  // APPROVER gates orders over spend limits but does not source.
  OWNER: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "rfq:manage",
    "cart:manage",
    "order:create",
    "order:approve",
    "sample:order",
    "analytics:view",
    "message:send",
  ],
  ADMIN: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "rfq:manage",
    "cart:manage",
    "order:create",
    "order:approve",
    "sample:order",
    "analytics:view",
    "message:send",
  ],
  BUYER: [
    "catalog:search",
    "workspace:manage",
    "rfq:create",
    "cart:manage",
    "order:create",
    "sample:order",
    "message:send",
  ],
  APPROVER: ["catalog:search", "order:approve", "analytics:view", "message:send"],
  // Supplier orgs — sales owns pricing, ops owns fulfillment and the
  // profile's operational data; both can run onboarding.
  SUPPLIER_SALES: [
    "supplier:onboard",
    "profile:manage",
    "listing:manage",
    "quote:create",
    "analytics:view",
    "message:send",
  ],
  SUPPLIER_OPS: [
    "supplier:onboard",
    "profile:manage",
    "shipment:manage",
    "analytics:view",
    "message:send",
  ],
  // Platform — Aekovera staff run verification, moderation, disputes,
  // and placement/commission settings.
  AEKOVERA_STAFF: [
    "supplier:verify",
    "moderation:manage",
    "dispute:mediate",
    "placement:manage",
    "analytics:view",
    "message:send",
  ],
};

describe("permission matrix (role × action)", () => {
  it("covers every defined role", () => {
    expect(Object.keys(EXPECTED_GRANTS).sort()).toEqual([...ROLES].sort());
  });

  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const expected = EXPECTED_GRANTS[role].includes(permission);
      it(`${role} × ${permission} → ${expected}`, () => {
        expect(can(role, permission)).toBe(expected);
      });
    }
  }
});

describe("assertCan", () => {
  it("returns silently for a granted permission", () => {
    expect(() => assertCan("SUPPLIER_SALES", "quote:create")).not.toThrow();
  });

  it("throws PermissionDeniedError with role and permission attached", () => {
    try {
      assertCan("BUYER", "quote:create");
      expect.unreachable("expected PermissionDeniedError");
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      const denied = error as PermissionDeniedError;
      expect(denied.role).toBe("BUYER");
      expect(denied.permission).toBe("quote:create");
      expect(denied.message).toContain("BUYER");
      expect(denied.message).toContain("quote:create");
    }
  });
});

describe("permissionsFor", () => {
  it("returns exactly the expected grants for every role", () => {
    for (const role of ROLES) {
      expect([...permissionsFor(role)].sort()).toEqual([...EXPECTED_GRANTS[role]].sort());
    }
  });

  it("never grants a permission outside the defined set", () => {
    for (const role of ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe("roleSide", () => {
  it("maps buyer, supplier, and platform roles", () => {
    expect(roleSide("OWNER")).toBe("buyer");
    expect(roleSide("ADMIN")).toBe("buyer");
    expect(roleSide("BUYER")).toBe("buyer");
    expect(roleSide("APPROVER")).toBe("buyer");
    expect(roleSide("SUPPLIER_SALES")).toBe("supplier");
    expect(roleSide("SUPPLIER_OPS")).toBe("supplier");
    expect(roleSide("AEKOVERA_STAFF")).toBe("platform");
  });
});
