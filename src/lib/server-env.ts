// Server-side environment validation.
//
// Every required server variable is read lazily inside handlers today; a
// missing SESSION_SECRET only surfaced as a thrown error on the 3rd or 4th
// step of an organizer login/sign-up (after useful work was already done).
// This check runs FIRST in every organizer server function and collects ALL
// missing variable names into one actionable message. Names only — values are
// never read, logged, or returned.
//
// Read via process.env (Node runtime on Nitro/Vercel/Workers). No
// import.meta.env usage exists anywhere in src/ (verified).

export type EnvCheckDefinition = {
  name: string;
  /** Required only when `when` returns true (defaults to always). */
  when?: () => boolean;
};

function definitions(): EnvCheckDefinition[] {
  return [
    { name: "TURSO_DATABASE_URL" },
    // Only needed for remote Turso (libsql://...) — local file: DBs run with no token.
    {
      name: "TURSO_AUTH_TOKEN",
      when: () => (process.env["TURSO_DATABASE_URL"] ?? "").startsWith("libsql://"),
    },
    { name: "SESSION_SECRET" },
  ];
}

/**
 * Throws ONE error naming every missing required variable, or returns silently.
 * Call at the top of organizer server-function handlers. Never logs/leaks values.
 */
export function assertServerEnv(): void {
  const missing: string[] = [];
  for (const def of definitions()) {
    if (def.when && !def.when()) continue;
    const value = process.env[def.name];
    if (!value || !value.trim()) missing.push(def.name);
  }
  if (missing.length) {
    throw new Error(
      `[server-env] Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in the hosting project's environment settings (server scope) and redeploy.`,
    );
  }
}
