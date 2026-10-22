import { z } from "zod";
import { clientContactInput } from "@/features/clients/clients.schemas";
import { DEFAULT_CREDIT_VALUE_PAISE, DEFAULT_PACKAGE_VALIDITY_DAYS } from "./packages.dto";

export const packageInput = z.object({
  name: z.string().trim().min(1, "Give the package a name").max(120),
  serviceIds: z.array(z.string().uuid()).default([]),
  /** How many credits the client gets. */
  sessions: z.number().int().min(1, "At least one credit").max(500),
  /** How much service price one credit covers (₹1,000 means a ₹1,500 service takes 1.5 credits). */
  creditValuePaise: z.number().int().min(100, "A credit must cover at least ₹1").max(100_000_000).default(DEFAULT_CREDIT_VALUE_PAISE),
  /** How many days the client has to use it after buying. Null = never expires. */
  validityDays: z.number().int().min(1).max(3650).nullable().default(DEFAULT_PACKAGE_VALIDITY_DAYS),
  pricePaise: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
  retiredAutomatically: z.boolean().default(false),
});
export type PackageInput = z.input<typeof packageInput>;
export type PackageData = z.output<typeof packageInput>;

export const sellInput = z.object({
  packageId: z.string().uuid(),
  /** How it was paid (cash, UPI reference ...), for the firm's own records. */
  paymentNote: z.string().trim().max(500).nullish(),
});

export const topUpInput = z.object({
  amountPaise: z.number().int().min(100, "Enter at least ₹1").max(100_000_000),
  note: z.string().trim().max(500).nullish(),
});

const razorpayId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_\-.]+$/, "Use the id exactly as Razorpay shows it");

/** The payment the website collected through Razorpay, as it reports it to us. */
const paymentDetails = z.object({
  /** What was charged, in paise: ₹3,600 is 360000. */
  amountPaise: z.coerce.number().int().min(100).max(100_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("INR"),
  razorpayOrderId: razorpayId.nullish(),
  /** Required: it is how a repeated report is recognised and ignored. */
  razorpayPaymentId: razorpayId,
  method: z.string().trim().max(40).nullish(),
  paidAt: z.union([z.coerce.date(), z.number().int().positive().transform((n) => new Date(n * 1000))]).nullish(),
});

/** Who bought it. A client we have never seen is created from this. */
const buyer = z.object({ client: clientContactInput });

export const packagePurchaseInput = paymentDetails.merge(buyer);
export const walletTopUpInput = paymentDetails.merge(buyer);
