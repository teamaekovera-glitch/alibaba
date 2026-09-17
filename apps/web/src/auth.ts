import NextAuth, { type DefaultSession, type NextAuthConfig, type Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { authSecret, verifyMagicToken } from "@/lib/magic-link";
import { verifyPassword } from "@/lib/password";

/**
 * Auth.js (next-auth v5) — JWT sessions, so no database session tables are
 * needed. Two sign-in paths feed the same credentials provider:
 *
 * - email + password (scrypt hash on the User row), or
 * - email + magicToken (HMAC-signed link token; auto-provisions the user).
 *
 * The session carries the user's active org membership and role — resolved
 * at sign-in from the schema's OrgMembership (first membership wins; the
 * org-switcher work will update the token via `auth.unstable_update`).
 */

export const authConfig = {
  secret: authSecret(),
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
        magicToken: {},
      },
      async authorize(fields) {
        const email = fields?.email?.toString().trim().toLowerCase();
        if (!email) {
          return null;
        }

        const magicToken = fields?.magicToken?.toString();
        const password = fields?.password?.toString();

        let user;
        if (magicToken) {
          const verified = verifyMagicToken(magicToken);
          if (!verified || verified.email !== email) {
            return null;
          }
          // Magic links self-provision: first sign-in creates the account.
          user = await db.user.upsert({
            where: { email },
            create: { email, emailVerified: new Date() },
            update: { emailVerified: new Date() },
          });
        } else if (password) {
          const existing = await db.user.findUnique({ where: { email } });
          if (!existing?.passwordHash || !(await verifyPassword(password, existing.passwordHash))) {
            return null;
          }
          user = existing;
        } else {
          return null;
        }

        const membership = await db.orgMembership.findFirst({
          where: { userId: user.id, org: { deletedAt: null } },
          orderBy: { createdAt: "asc" },
          include: { org: { select: { slug: true, type: true } } },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          membership: membership
            ? {
                orgId: membership.orgId,
                orgSlug: membership.org.slug,
                orgType: membership.org.type,
                role: membership.role,
              }
            : null,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }: { token: JWT; user: DefaultSession["user"] & { membership?: ActiveMembership | null } }) {
      if (user) {
        token.membership = user.membership ?? null;
      }
      return token;
    },
    session({ session, token }: { session: Session; token: JWT }) {
      session.user = {
        id: token.sub ?? "",
        email: session.user?.email ?? "",
        name: session.user?.name ?? null,
        ...activeMembershipFields(token.membership),
      };
      return session;
    },
  },
};

authConfig satisfies NextAuthConfig;

export interface ActiveMembership {
  orgId: string;
  orgSlug: string;
  orgType: string;
  role: string;
}

interface TokenWithMembership {
  membership?: ActiveMembership | null;
}

function activeMembershipFields(membership: ActiveMembership | null | undefined) {
  return {
    orgId: membership?.orgId ?? null,
    orgSlug: membership?.orgSlug ?? null,
    orgType: membership?.orgType ?? null,
    role: membership?.role ?? null,
  };
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string | null;
      orgId: string | null;
      orgSlug: string | null;
      orgType: string | null;
      role: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging onto next-auth's JWT requires an interface; TokenWithMembership already carries the session shape
  interface JWT extends TokenWithMembership {}
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
