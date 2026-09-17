/**
 * Programmatically generated placeholder listing art: one deterministic SVG
 * per top-level packaging category, rendered to PNG via resvg and embedded as
 * a data URI. No AI calls, no external services, no API keys (spec:
 * mock-first), and rendering is pure — same SVG bytes → same PNG bytes.
 */

import { Resvg } from "@resvg/resvg-js";

const WIDTH = 720;
const HEIGHT = 540;

/** Stable hue per category slug — deterministic without an RNG dependency. */
function hueFor(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function categorySvg(slug: string, labelHue: number): string {
  const hue = hueFor(slug);
  const hue2 = (hue + 40) % 360;
  // Geometric composition only: no <text>, so no font resolution is needed
  // and rendering stays deterministic across environments.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 55%, 88%)"/>
      <stop offset="100%" stop-color="hsl(${hue2}, 45%, 78%)"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect x="240" y="150" width="240" height="260" rx="18" fill="hsl(${hue}, 50%, 42%)"/>
  <rect x="262" y="128" width="196" height="44" rx="10" fill="hsl(${hue2}, 55%, 52%)"/>
  <rect x="262" y="210" width="196" height="12" rx="6" fill="hsl(${labelHue}, 60%, 72%)"/>
  <rect x="262" y="238" width="150" height="12" rx="6" fill="hsl(${labelHue}, 60%, 80%)"/>
  <circle cx="560" cy="130" r="46" fill="hsl(${hue2}, 60%, 60%)" opacity="0.55"/>
  <circle cx="160" cy="410" r="70" fill="hsl(${hue}, 45%, 65%)" opacity="0.45"/>
  <path d="M120 110 L 210 60 L 300 110" fill="none" stroke="hsl(${hue2}, 50%, 45%)" stroke-width="14" stroke-linecap="round" opacity="0.6"/>
</svg>`;
}

/** Renders one SVG to a PNG data URI (base64). */
export function renderPngDataUri(svg: string): string {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** One PNG data URI per top-level category slug, rendered once per seed run. */
export function categoryImageDataUris(topSlugs: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const slug of topSlugs) {
    map.set(slug, renderPngDataUri(categorySvg(slug, (hueFor(slug) + 180) % 360)));
  }
  return map;
}
