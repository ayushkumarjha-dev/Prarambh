// Organizer authentication server functions (replaces Supabase Auth/GoTrue).
//
//  - organizerLogin: bcrypt-verify email + password, issue an HMAC session.
//  - organizerSignUp: bootstrap-only — allowed while ZERO organizers exist
//    (mirrors the old grant_first_admin trigger; the UI labels this mode
//    "Create the first organizer account"). Later accounts must be created
//    server-side (scripts) with an explicit role.
//
// Only hashes are stored; passwords never leave the server. Failed attempts
// use the same 5-attempts / 10-minute lockout as the participant login.
//
// Error contract (v2): functions NEVER throw user-facing failures — they
// return a typed { ok: false, code, message } result with a safe message.
// Domain errors are classified; unexpected errors are logged server-side with
// structured fields (function name, step, message, stack — never secrets or
// user PII) and surfaced to the client with a generic-safe message. Wire
// transport still maps thrown errors (e.g. the env check itself) to HTTP with
// the error serialized into the body (TanStack Start behavior).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertServerEnv } from "@/lib/server-env";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 10;

/** User-safe failure codes returned to the client instead of thrown errors. */
export type OrganizerAuthFailureCode =
  | "SESSION_SECRET_MISSING" // SESSION_SECRET not configured (exact name in the message)
  | "ENV_MISSING" // TURSO_* variable(s) not configured (exact names in the message)
  | "DB_ERROR" // database read/write failed (details only in server logs)
  | "INVALID_CREDENTIALS" // unknown email OR wrong password (same message by design)
  | "EMAIL_EXISTS" // sign-up with an email that already exists
  | "REGISTRATION_CLOSED" // sign-up after the first organizer account exists
  | "VALIDATION_ERROR" // input rejected (e.g. password too short)
  | "INTERNAL_ERROR"; // unexpected failure (details only in server logs)

/** User-facing display names -> safe message shown by the login UI. */
const SAFE_MESSAGES: Record<OrganizerAuthFailureCode, string> = {
  SESSION_SECRET_MISSING:
    "Server setup is incomplete — the session secret (SESSION_SECRET) is not configured. Contact the platform operator.",
  ENV_MISSING:
    "Server setup is incomplete — required environment variables are missing. Contact the platform operator.",
  DB_ERROR: "The exam database is unavailable right now. Please try again shortly.",
  INVALID_CREDENTIALS: "Invalid credentials.",
  EMAIL_EXISTS: "That email is already registered.",
  REGISTRATION_CLOSED: "Registration is closed. Ask the existing organizer to add your account.",
  VALIDATION_ERROR: "Please check the form — the input was rejected.",
  INTERNAL_ERROR: "Organizer sign-in is temporarily unavailable. Please try again shortly.",
};

export type OrganizerAuthResult =
  | {
      ok: true;
      token: string;
      expiresAt: number; // unix milliseconds
      user: { id: string; email: string; role: string; display_name: string };
    }
  | { ok: false; code: OrganizerAuthFailureCode; message: string };

/** Server-side domain error carrying a user-safe code + message. */
class AuthError extends Error {
  code: OrganizerAuthFailureCode;
  constructor(code: OrganizerAuthFailureCode, message?: string) {
    super(message ?? SAFE_MESSAGES[code]);
    this.name = "AuthError";
    this.code = code;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Structured server-side auth error log. Contains the function name, the step
 * at which the failure occurred, and message/stack only — never credentials,
 * user emails, password hashes, tokens, or secret values.
 */
function logAuthError(
  fn: "organizerLogin" | "organizerSignUp",
  step: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[${fn}] failed at step "${step}": ${message}`, stack ? { stack } : undefined);
}

/** Map any caught error onto the typed failure result (safe for the client). */
function failureFrom(
  fn: "organizerLogin" | "organizerSignUp",
  step: string,
  error: unknown,
): OrganizerAuthResult {
  logAuthError(fn, step, error);
  if (error instanceof AuthError) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("[server-env]")) {
    // assertServerEnv's throw lists the missing variable NAMES (never values),
    // so surfacing them verbatim is the whole point of the env check.
    const names = message.match(/variable\(s\):\s*([^.]+)\./i)?.[1]?.trim();
    return {
      ok: false,
      code: names === "SESSION_SECRET" ? "SESSION_SECRET_MISSING" : "ENV_MISSING",
      message: `Server setup is incomplete — ${message.replace("[server-env] ", "")}`,
    };
  }
  if (message.startsWith("[db]")) {
    return { ok: false, code: "DB_ERROR", message: SAFE_MESSAGES.DB_ERROR };
  }
  return { ok: false, code: "INTERNAL_ERROR", message: SAFE_MESSAGES.INTERNAL_ERROR };
}

async function bcryptCompare(password: string, hash: string): Promise<boolean> {
  try {
    const mod = await import("bcryptjs");
    const bcrypt = mod.default ?? mod;
    return (await bcrypt.compare(password, hash)) === true;
  } catch {
    return false;
  }
}

async function bcryptHash(password: string): Promise<string> {
  const mod = await import("bcryptjs");
  const bcrypt = mod.default ?? mod;
  return bcrypt.hash(password, 10);
}

export const organizerLogin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(200),
        password: z.string().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<OrganizerAuthResult> => {
    let step = "env";
    try {
      assertServerEnv();
      const { db } = await import("@/integrations/turso/client.server");
      const { signOrganizerToken } = await import("@/integrations/turso/session-token");

      const email = normalizeEmail(data.email);
      // Same message for unknown email vs wrong password: no account enumeration.
      const invalid = "Invalid credentials.";

      step = "db_read";
      const { data: organizer, error: readErr } = await db
        .from("organizers")
        .select("id, email, password_hash, role, display_name, failed_attempts, locked_until")
        .eq("email", email)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      if (!organizer?.password_hash) {
        // Unknown email: count as failed attempt for lockout symmetry? Kept as
        // before: unknown emails do not increment anything.
        return { ok: false, code: "INVALID_CREDENTIALS", message: invalid };
      }

      if (organizer.locked_until && new Date(organizer.locked_until).getTime() > Date.now()) {
        throw new AuthError(
          "INVALID_CREDENTIALS",
          "Too many failed attempts. Please try again in a few minutes.",
        );
      }

      step = "bcrypt_compare";
      const match = await bcryptCompare(data.password, organizer.password_hash);
      if (!match) {
        const failed = Number(organizer.failed_attempts ?? 0) + 1;
        const locked = failed >= MAX_FAILED_ATTEMPTS;
        step = "db_lockout_write";
        const { error: writeErr } = await db
          .from("organizers")
          .update({
            failed_attempts: locked ? 0 : failed,
            locked_until: locked
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
              : null,
          })
          .eq("id", organizer.id);
        if (writeErr) throw new Error(writeErr.message);
        if (locked) {
          throw new AuthError(
            "INVALID_CREDENTIALS",
            "Too many failed attempts. Please try again in a few minutes.",
          );
        }
        return { ok: false, code: "INVALID_CREDENTIALS", message: invalid };
      }

      step = "db_reset_attempt_counter";
      const { error: resetErr } = await db
        .from("organizers")
        .update({ failed_attempts: 0, locked_until: null })
        .eq("id", organizer.id);
      if (resetErr) throw new Error(resetErr.message);

      step = "sign_token";
      const user = {
        id: String(organizer.id),
        email: String(organizer.email),
        role: String(organizer.role ?? "admin"),
        display_name: String(organizer.display_name ?? ""),
      };
      const { token, expiresAt } = signOrganizerToken({
        sub: user.id,
        email: user.email,
        role: user.role === "user" ? "user" : "admin",
      });
      return { ok: true, token, expiresAt, user };
    } catch (error) {
      return failureFrom("organizerLogin", step, error);
    }
  });

export const organizerSignUp = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(200),
        password: z.string().max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<OrganizerAuthResult> => {
    let step = "env";
    try {
      if (data.password.length < 8) {
        throw new AuthError("VALIDATION_ERROR", "Password must be at least 8 characters.");
      }
      assertServerEnv();
      const { db } = await import("@/integrations/turso/client.server");
      const { signOrganizerToken } = await import("@/integrations/turso/session-token");

      // Bootstrap gate: without Supabase email confirmation there is no invite
      // flow, so account creation stays closed once any organizer exists.
      step = "db_read_any_existing";
      const { data: existing, error: countErr } = await db.from("organizers").select("id").limit(1);
      if (countErr) throw new Error(countErr.message);
      if (existing?.length) throw new AuthError("REGISTRATION_CLOSED");

      step = "bcrypt_hash";
      const email = normalizeEmail(data.email);
      const passwordHash = await bcryptHash(data.password);

      step = "db_insert";
      const { data: created, error: insertErr } = await db
        .from("organizers")
        .insert({
          email,
          password_hash: passwordHash,
          display_name: "",
          role: "admin",
        })
        .select("id, email, role, display_name")
        .single();
      if (insertErr) {
        if (insertErr.code === "23505") throw new AuthError("EMAIL_EXISTS");
        throw new Error(insertErr.message);
      }

      step = "sign_token";
      const user = {
        id: String(created.id),
        email: String(created.email),
        role: String(created.role ?? "admin"),
        display_name: String(created.display_name ?? ""),
      };
      const { token, expiresAt } = signOrganizerToken({
        sub: user.id,
        email: user.email,
        role: user.role === "user" ? "user" : "admin",
      });
      return { ok: true, token, expiresAt, user };
    } catch (error) {
      return failureFrom("organizerSignUp", step, error);
    }
  });
