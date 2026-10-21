import { z } from "zod";

// All settings and secrets come from environment variables; see .env.example.
const schema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32),
  /** Comma-separated emails that become admins on their first login. */
  ADMIN_EMAILS: z.string().default(""),
  /** Optional: only allow accounts from this email domain (e.g. yourfirm.com). */
  ALLOWED_EMAIL_DOMAIN: z.string().optional(),
});

/** Names of required settings that are missing or invalid (empty when all is well). */
export function missingEnv(env: Record<string, string | undefined> = process.env): string[] {
  const parsed = schema.safeParse(env);
  const missing = parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
  const google = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const zoho = Boolean(env.AUTH_ZOHO_ID && env.AUTH_ZOHO_SECRET);
  const local = env.NODE_ENV !== "production" && Boolean(env.LOCAL_LOGIN_PASSWORD);
  // A firm may sign in with personal passwords only (set with `npm run staff:set-password`).
  const passwords = env.PASSWORD_LOGIN === "on";
  // Staff need at least one way to sign in.
  if (!google && !zoho && !local && !passwords) missing.push("AUTH_GOOGLE_ID+AUTH_GOOGLE_SECRET or AUTH_ZOHO_ID+AUTH_ZOHO_SECRET or PASSWORD_LOGIN=on");
  return missing;
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
