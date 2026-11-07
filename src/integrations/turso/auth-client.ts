// Browser-side organizer auth client (replaces the Supabase client's `auth`
// API). Keeps the call shapes the route guards and login page already use:
//
//   const { data: { session } } = await authClient.getSession();
//   const { error } = await authClient.signInWithPassword({ email, password });
//   const { error } = await authClient.signUp({ email, password });
//   await authClient.signOut();
//
// getSession() reads localStorage only — no network — so route guards and
// Android-back navigation in the installed PWA never depend on connectivity
// (the session token itself is still verified server-side on every call).
//
// Error contract (v2): organizer server functions RETURN typed failures
// ({ ok: false, code, message }) with user-safe messages instead of
// throwing. This client relays `message` + `code` verbatim; anything thrown
// in transport (network failure, validation serializer) is converted, keeping
// the real message whenever it is safe and a clear fallback otherwise.
// Previously a failed call rejected with a plain { message } object, which
// the login page then re-threw — `err instanceof Error` was false there, so
// the UI always showed its generic fallback instead of the server's message.
import {
  organizerLogin,
  organizerSignUp,
  type OrganizerAuthFailureCode,
} from "@/lib/auth.functions";

import { clearSession, readSession, writeSession, type StoredSession } from "./session-storage";

export type OrganizerSession = StoredSession;

/** Error object surfaced to the UI: safe message plus optional failure code. */
export type OrganizerAuthError = { message: string; code?: OrganizerAuthFailureCode };

/** Best-effort message extraction from anything a failed promise rejected with. */
function messageToDisplay(thrown: unknown, fallback: string): string {
  let message: string | undefined;
  if (thrown instanceof Error) message = thrown.message;
  else if (typeof thrown === "string") message = thrown;
  else if (
    thrown &&
    typeof thrown === "object" &&
    "message" in thrown &&
    typeof (thrown as { message: unknown }).message === "string"
  ) {
    message = (thrown as { message: string }).message;
  }
  if (!message?.trim()) return fallback;
  // Zod rejects (server input validation) serialize as a JSON issues array —
  // never render raw JSON to the user.
  if (/^\s*\[\s*\{/.test(message)) {
    return "Please check the form — the email or password looks invalid.";
  }
  return message;
}

export const authClient = {
  /** Local session read: returns { data: { session } } like supabase.auth. */
  async getSession(): Promise<{ data: { session: OrganizerSession | null } }> {
    return { data: { session: readSession() } };
  },

  async signOut(): Promise<{ error: null }> {
    clearSession();
    return { error: null };
  },

  async signInWithPassword(creds: {
    email: string;
    password: string;
  }): Promise<{ error: OrganizerAuthError | null }> {
    try {
      const result = await organizerLogin({ data: creds });
      if (!result.ok) {
        return { error: { message: result.message, code: result.code } };
      }
      writeSession({
        token: result.token,
        expiresAt: result.expiresAt,
        user: result.user,
      });
      return { error: null };
    } catch (err) {
      return { error: { message: messageToDisplay(err, "Sign in failed. Please try again.") } };
    }
  },

  /**
   * Bootstrap signup: creates the first organizer account (server enforces
   * that no organizer exists yet) and signs in immediately — there is no
   * email-confirmation step anymore. The `options` argument is accepted for
   * call-site compatibility with the old supabase.auth.signUp signature and
   * ignored.
   */
  async signUp(
    creds: { email: string; password: string },
    _options?: unknown,
  ): Promise<{ error: OrganizerAuthError | null }> {
    try {
      const result = await organizerSignUp({ data: creds });
      if (!result.ok) {
        return { error: { message: result.message, code: result.code } };
      }
      writeSession({
        token: result.token,
        expiresAt: result.expiresAt,
        user: result.user,
      });
      return { error: null };
    } catch (err) {
      return { error: { message: messageToDisplay(err, "Sign up failed. Please try again.") } };
    }
  },
};
