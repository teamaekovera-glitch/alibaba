/**
 * Domain logic lives here: pricing & landed cost, the escrow state machine,
 * permissions, dedup scoring, and attribute validation (spec: packages/core).
 * The scaffold ships the module shell; the pure-function rules land with the
 * schema and domain workstreams.
 */
export const CORE_PACKAGE_VERSION = "0.1.0" as const;

export interface PackageInfo {
  name: string;
  version: string;
}

export function packageInfo(): PackageInfo {
  return { name: "@packsource/core", version: CORE_PACKAGE_VERSION };
}
