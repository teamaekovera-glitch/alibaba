/**
 * Domain logic: pricing & landed cost, permission gates, dedup scoring, and
 * attribute validation (spec: packages/core).
 *
 * Shipped so far:
 * - permissions — central permission definitions and the role matrix
 */
export const CORE_PACKAGE_VERSION = "0.1.0" as const;

export interface PackageInfo {
  name: string;
  version: string;
}

export function packageInfo(): PackageInfo {
  return { name: "@packsource/core", version: CORE_PACKAGE_VERSION };
}

export * from "./permissions";
export * from "./onboarding";
export * from "./repositories";
