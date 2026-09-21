import { agentAuth, agentPage, agentRateLimit, parseAgentPaging, serializeAgentSupplier } from "@packsource/agent-api";
import { db } from "@/lib/db";

/**
 * Agent-readable supplier directory (spec: agent surface). Bearer-key auth,
 * rate limited, read-only. Exposes supplier orgs that have completed
 * onboarding (a SupplierProfile exists); verification status is surfaced as
 * data so agents can filter rather than hidden at the loader.
 */
export const dynamic = "force-dynamic";

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
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: paging.offset,
      take: paging.limit,
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

  return agentPage(rows.map((row) => serializeAgentSupplier(row)), paging, total);
}
