import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { bookingIcs } from "@/lib/ics";
import { NotConfigured, type OutgoingMessage, type Sender } from "./workflows.dto";
import type { Senders } from "./workflows.service";

type Env = Record<string, string | undefined>;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/**
 * Google shows an app password in four groups of four letters, and people paste it with those spaces. The spaces are
 * not part of the password, so they are dropped for Google's mail servers (other providers' passwords are left as typed).
 */
export function smtpPassword(env: Env): string | undefined {
  const pass = env.SMTP_PASS;
  return pass && /(^|\.)(gmail|google|googlemail)\.com$/i.test(env.SMTP_HOST ?? "") ? pass.replace(/\s+/g, "") : pass;
}

/** SMTP works with Zoho Mail, Gmail, SES and most providers: the firm picks one in its environment settings. */
function emailSender(env: Env): Sender {
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  return async (msg: OutgoingMessage) => {
    if (msg.channel !== "email") throw new Error("Wrong channel");
    if (!env.SMTP_HOST || !env.EMAIL_FROM) throw new NotConfigured("Email isn't set up yet. Set SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM.");
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT ?? 465),
      // Port 465 speaks TLS from the start; 587 upgrades after connecting.
      secure: Number(env.SMTP_PORT ?? 465) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: smtpPassword(env) } : undefined,
    });
    // The invite says it comes from the same address the email does; Gmail ignores invites whose organiser differs.
    const from = /<([^>]+)>/.exec(env.EMAIL_FROM)?.[1] ?? env.EMAIL_FROM;
    const invite = msg.invite;
    const info = await transport.sendMail({
      ...(invite
        ? {
            icalEvent: {
              method: invite.method,
              content: bookingIcs({ ...invite, method: invite.method, organizer: { email: from.trim() } }),
            },
          }
        : {}),
      from: env.EMAIL_FROM,
      // Replies go to the front desk rather than the no-reply style address mail is sent from.
      replyTo: env.EMAIL_REPLY_TO || undefined,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
      html: msg.html ?? `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(msg.body)}</div>`,
    });
    return { providerMessageId: info.messageId };
  };
}

/** WhatsApp Cloud API. Business-started chats must use a template Meta has approved. */
function whatsappSender(env: Env): Sender {
  return async (msg) => {
    if (msg.channel !== "whatsapp") throw new Error("Wrong channel");
    if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
      throw new NotConfigured("WhatsApp isn't set up yet. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.");
    }
    const res = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: msg.templateName,
          language: { code: msg.language },
          components: msg.params.length ? [{ type: "body", parameters: msg.params.map((text) => ({ type: "text", text })) }] : [],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp refused the message: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return { providerMessageId: json.messages?.[0]?.id };
  };
}

/** The "custom workflow": POST the booking as JSON to the firm's own URL, signed so the receiver can trust it. */
function webhookSender(env: Env): Sender {
  return async (msg) => {
    if (msg.channel !== "webhook") throw new Error("Wrong channel");
    const body = JSON.stringify(msg.payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.WORKFLOW_WEBHOOK_SECRET) {
      headers["X-Signature"] = "sha256=" + createHmac("sha256", env.WORKFLOW_WEBHOOK_SECRET).update(body).digest("hex");
    }
    const res = await fetch(msg.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`${msg.url} answered HTTP ${res.status}`);
    return {};
  };
}

export function createSenders(env: Env = process.env): Senders {
  return { email: emailSender(env), whatsapp: whatsappSender(env), webhook: webhookSender(env) };
}
