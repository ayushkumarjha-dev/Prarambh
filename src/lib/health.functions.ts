// Public (no-auth) health check for the organizer auth stack.
//
// Reports booleans and missing variable NAMES only — never secret values,
// row counts, or table content. Call it (from DevTools console or curl)
// after a failed Sign In to tell apart the deployment failure modes:
//   - environment not configured        -> missingEnv lists the exact names
//   - Turso unreachable / bad URL+token -> db: false
//   - organizers table missing/renamed  -> organizersTable: false
//   - session signing unavailable       -> sessionSecret: false
//
// Students share the same DB connection, so `db: false` would affect exams
// too; a false `sessionSecret` only breaks organizer sign-in/sign-up makes
// it the smoking gun for "students work, organizers don't".
import { createServerFn } from "@tanstack/react-start";

export type OrganizerHealthReport = {
  db: boolean; // SELECT 1 against Turso succeeded
  organizersTable: boolean; // organizers row readable (SELECT id LIMIT 1)
  sessionSecret: boolean; // SESSION_SECRET present (value never returned)
  missingEnv: string[]; // names of missing required variables
};

export const organizerHealthCheck = createServerFn({ method: "GET" }).handler(
  async (): Promise<OrganizerHealthReport> => {
    const missingEnv: string[] = [];
    for (const name of ["TURSO_DATABASE_URL", "SESSION_SECRET"]) {
      if (!process.env[name]?.trim()) missingEnv.push(name);
    }
    if (
      (process.env["TURSO_DATABASE_URL"] ?? "").startsWith("libsql://") &&
      !process.env["TURSO_AUTH_TOKEN"]?.trim()
    ) {
      missingEnv.push("TURSO_AUTH_TOKEN");
    }

    let db = false;
    let organizersTable = false;
    try {
      const { getLibsql } = await import("@/integrations/turso/client.server");
      await getLibsql().execute("SELECT 1");
      db = true;
    } catch {
      db = false;
    }
    if (db) {
      try {
        const { db: client } = await import("@/integrations/turso/client.server");
        const probe = await client.from("organizers").select("id").limit(1);
        organizersTable = !probe.error;
      } catch {
        organizersTable = false;
      }
    }

    return {
      db,
      organizersTable,
      sessionSecret: Boolean(process.env["SESSION_SECRET"]?.trim()),
      missingEnv,
    };
  },
);
