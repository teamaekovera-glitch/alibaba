import type { MetadataRoute } from "next";
import { robotsRules } from "@packsource/seo";
import { siteOrigin } from "@/lib/seo";

/** robots.txt: index public catalog surfaces, block app and API areas. */
export default function robots(): MetadataRoute.Robots {
  const rules = robotsRules(siteOrigin());
  return {
    rules: { userAgent: "*", allow: "/", disallow: rules.disallow },
    sitemap: rules.sitemap,
  };
}
