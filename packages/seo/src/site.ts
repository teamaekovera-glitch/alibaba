/** Canonical production origin for canonical URLs, sitemap, and robots. */
export const DEFAULT_SITE_URL = "https://packsource.aekovera.com";

/** Env override so previews/staging render self-consistent absolute URLs. */
export const SITE_URL_ENV = "NEXT_PUBLIC_SITE_URL";

/**
 * Resolve the site origin: NEXT_PUBLIC_SITE_URL when set, else the
 * production default. Trailing slashes are stripped.
 */
export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[SITE_URL_ENV]?.trim();
  const url = raw && raw.length > 0 ? raw : DEFAULT_SITE_URL;
  return url.replace(/\/+$/, "");
}

/** Join the site origin and a root-relative path into an absolute URL. */
export function absoluteUrl(site: string, path: string): string {
  return `${site.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
