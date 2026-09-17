/**
 * Re-export of the generated Prisma client. Sibling packages depend on
 * `@packsource/db` rather than reaching for the generated artifact's
 * location, so the schema stays an implementation detail of this package.
 *
 * Re-exports everything — model and enum types live at the top level of
 * @prisma/client (only `Prisma.*` utility types are namespaced).
 */
export * from "@prisma/client";
