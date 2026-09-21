import { agentAuth, agentPage, agentRateLimit, parseAgentPaging, serializeAgentSupplier } from "@packsource/agent-api";
import { db } from "@/lib/db";

/**
 * Agent-readable supplier directory (spec: agent surface). Bearer-key auth,
 * rate limited, read-only. Exposes supplier orgs that have completed
 * onboarding (a SupplierProfile exists); verification status is surfaced as
 * data so agents can filter rather than hidden at the loader.
 */
export const dynamic = "force-dynamic";

/**
 * Codepoint ordering for the agent directory contract: byte-wise name
 * comparison is identical on every environment (no database collation
 * involved), with id as the deterministic tie-break.
 */
function byNameThenId(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function GET(request: Request): Promise<Response> {
  const gate = agentAuth(request);
  if (!gate.ok) {
    return gate.response;
  }
  const limit = agentRateLimit(gate.orgId, new Date());
  if (!limit.ok) {
    return limit.response;
  }

  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug");
  const where = {
    type: "SUPPLIER" as const,
    supplierProfile: { isNot: null },
    ...(slug ? { slug } : {}),
  };

  const paging = parseAgentPaging(searchParams);
  const [rows, total] = await Promise.all([
    db.organization.findMany({
      where,
      // Id order from the database is stable everywhere; the exposed ordering
      // is applied below in TypeScript because SQL `ORDER BY name` follows the
      // database collation and would not be deterministic across environments.
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        supplierProfile: {
          select: {
            verificationStatus: true,
            responseTimeHours: true,
            minOrderValueCents: true,
            paymentTerms: true,
            about: true,
            plants: { select: { city: true, country: true, isPrimary: true }, orderBy: { createdAt: "asc" } },
          },
        },
      },
    }),
    db.organization.count({ where }),
  ]);

  const sorted = [...rows].sort(byNameThenId);
  const page = sorted.slice(paging.offset, paging.offset + paging.limit);
  return agentPage(page.map((row) => serializeAgentSupplier(row)), paging, total);
}
