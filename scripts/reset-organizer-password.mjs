// Sets (or resets) an organizer's password directly in the configured database.
//
//   node scripts/reset-organizer-password.mjs
//
// Interactively prompts for the organizer email and a new password (min 8
// characters), hashes it with bcryptjs, stores it, and clears that account's
// login-lockout state. The password is typed on this machine only; the script
// never prints the raw password or the stored hash.
//
// Input is read as raw "line" events into a queue (instead of the promises
// API's question()) so the flow works identically for an interactive terminal
// and for piped/redirected stdin, where line events can all arrive in the
// first data chunk.
//
// Env: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (loaded from .env, like
// db-migrate; values already set in the shell win).
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import readline from "node:readline";
import process, { stdin, stdout, exit } from "node:process";

import { loadEnv } from "./load-env.mjs";

loadEnv();

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("Missing TURSO_DATABASE_URL (libsql://... or file:./local.db).");
  exit(1);
}

const target = url.startsWith("file:") ? url : `Turso host ${new URL(url).host}`;
console.log(`Database: ${target}`);

/** Collect exactly two lines from stdin (works for TTY and piped input). */
function readTwoLines() {
  return new Promise((resolve) => {
    const collected = [];
    const rl = readline.createInterface({ input: stdin, output: stdout });
    process.stdout.write("Organizer email to reset: ");
    rl.on("line", (line) => {
      collected.push(line);
      if (collected.length === 1) {
        process.stdout.write("New password (min 8 characters; visible while typing): ");
      }
      if (collected.length >= 2) {
        rl.close();
        resolve(collected);
      } else if (line === "") {
        // Empty input (EOF of a pipe) — stop waiting with what we have so the
        // validation below can explain the problem instead of hanging.
        rl.close();
        resolve(collected);
      }
    });
    rl.on("close", () => resolve(collected));
  });
}

const [email, password] = (await readTwoLines()).map((line) => line.trim());
if (!email.includes("@")) {
  console.error("That is not an email address. Aborting — nothing was changed.");
  exit(1);
}
if (!password || password.length < 8) {
  console.error("Password is missing or shorter than 8 characters. Aborting — nothing was changed.");
  exit(1);
}

const passwordHash = bcrypt.hashSync(password, 10);

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const res = await client.execute({
  sql: "UPDATE organizers SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE lower(email) = ?",
  args: [passwordHash, email],
});

if (!res.rowsAffected) {
  console.error(`No organizer row found for "${email}" — nothing was changed.`);
  console.error("Check the exact email you registered with, then run again.");
  exit(1);
}

console.log(`Password updated for ${email}; failed-attempt counter and lock cleared.`);
console.log("Sign in on the site now with the new password.");
exit(0);
