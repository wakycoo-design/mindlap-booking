/** Wallet money expires a year after it was added. */
export const WALLET_VALIDITY_DAYS = 365;
/** Default life of a package when none is set on it. */
export const DEFAULT_PACKAGE_VALIDITY_DAYS = 365;
/** Default service price one credit covers: ₹1,000, so a ₹1,500 service takes 1.5 credits. */
export const DEFAULT_CREDIT_VALUE_PAISE = 100_000;
/** Credits are kept in thousandths so part of a credit stays exact. */
export const MILLI = 1000;

/** A package on sale: a number of credits for one price. */
export type PackageDTO = {
  id: string;
  name: string;
  /** Services it can pay for. Empty means any service. */
  serviceIds: string[];
  /** How many credits the client gets. */
  sessions: number;
  /** Service price one credit covers, in paise. */
  creditValuePaise: number;
  validityDays: number | null;
  pricePaise: number;
  active: boolean;
  /** The app took this price tier off sale itself (nobody charged its price), so it may put it back. */
  retiredAutomatically: boolean;
};

/** One package a client bought. Credits are decimals (1.5 = a credit and a half). */
export type ClientPackageDTO = {
  id: string;
  clientId: string;
  packageId: string;
  packageName: string;
  serviceIds: string[];
  creditsTotal: number;
  creditsLeft: number;
  creditValuePaise: number;
  pricePaise: number;
  /** The money still unspent from what the client paid. */
  valueLeftPaise: number;
  expiresAt: Date | null;
  paymentNote: string | null;
  createdAt: Date;
};

/** One top-up of wallet money. */
export type WalletLotDTO = {
  id: string;
  amountPaise: number;
  remainingPaise: number;
  expiresAt: Date;
  note: string | null;
  createdAt: Date;
};

/** Everything a client can still spend. Expired and used-up items are left out. */
export type CreditSummaryDTO = {
  packages: ClientPackageDTO[];
  lots: WalletLotDTO[];
  /** Money from top-ups, spent directly on bookings. */
  walletPaise: number;
  /** What the unused package credits are worth. It falls by each credit's share as credits are used. */
  packageValuePaise: number;
  /** Everything the client has paid for and not yet used: top-ups plus package value. */
  totalPaise: number;
};

/** One line of what a booking was paid with. */
export type CreditUseDTO = {
  id: string;
  bookingId: string;
  bookingNumber: number;
  kind: "package" | "wallet";
  label: string;
  credits: number;
  /** How much of the booking's price this paid. */
  coveredPaise: number;
  amountPaise: number;
  valuePaise: number;
  returnedAt: Date | null;
  createdAt: Date;
};

/** What a booking took when it was made. `credits` are package credits, `walletPaise` is top-up money. */
export type CreditTaken = { credits: number; walletPaise: number };

export type PackageBalance = {
  id: string;
  leftMilli: number;
  totalMilli: number;
  creditValuePaise: number;
  /** What the client paid for the whole package. */
  pricePaise: number;
  /** Money still unspent from that. */
  valueLeftPaise: number;
};
export type LotBalance = { id: string; remainingPaise: number };

/** How a booking's price would be paid. */
export type Allocation = {
  packages: { id: string; milli: number; coveredPaise: number; valuePaise: number }[];
  lots: { id: string; amountPaise: number }[];
  creditsMilli: number;
  walletPaise: number;
  /** What is still left to pay after credit. Null when the price is unknown (a text price like "From ₹500"). */
  duePaise: number | null;
  /** Nothing left to pay. */
  covered: boolean;
};

/** The money a use takes off a package's value: the package rate at its own tier or below, the full price above it. */
function packageValue(p: PackageBalance, milli: number, coveredPaise: number, servicePricePaise: number): number {
  if (servicePricePaise > p.creditValuePaise) return Math.min(coveredPaise, p.valueLeftPaise);
  // Using the last of the credits closes the package, so rounding never strands a few paise.
  if (milli === p.leftMilli) return p.valueLeftPaise;
  return Math.min(p.valueLeftPaise, Math.round((p.pricePaise * milli) / p.totalMilli));
}

/**
 * Works out how a price is paid from a client's credit, without writing anything (so a quote and a real booking
 * always agree). Package credits come first, in the order given, each covering its `creditValuePaise` per credit; a
 * ₹1,500 service takes 1.5 credits of a ₹1,000-credit package. Wallet money pays what packages don't, and whatever
 * is left is paid in the normal way. A service with no known price counts as one credit, with nothing to charge.
 *
 * The money a package use takes off the client's package value depends on the tier. At or below the tier the package
 * was bought for (price within one credit's value) the client keeps the package rate: 1 credit takes ₹900 of a
 * ₹3,600 four-credit package. Above it there is no discount: a ₹1,500 service takes 1.5 credits and the full ₹1,500.
 * Credits and money therefore move separately, which is why both are stored.
 */
export function allocate(pricePaise: number | null, packages: PackageBalance[], lots: LotBalance[]): Allocation {
  const out: Allocation = { packages: [], lots: [], creditsMilli: 0, walletPaise: 0, duePaise: pricePaise, covered: false };
  if (pricePaise === null) {
    const p = packages.find((x) => x.leftMilli >= MILLI);
    if (p) {
      out.packages.push({
        id: p.id,
        milli: MILLI,
        coveredPaise: p.creditValuePaise,
        valuePaise: packageValue(p, MILLI, p.creditValuePaise, p.creditValuePaise),
      });
      out.creditsMilli = MILLI;
      out.covered = true;
    }
    return out;
  }
  let remaining = pricePaise;
  for (const p of packages) {
    if (remaining <= 0) break;
    const coverable = Math.floor((p.leftMilli * p.creditValuePaise) / MILLI);
    if (coverable <= 0) continue;
    const take = Math.min(remaining, coverable);
    // Using up the last of a package takes exactly what is left, so rounding never strands a sliver of a credit.
    const milli = take === coverable ? p.leftMilli : Math.min(p.leftMilli, Math.max(1, Math.round((take * MILLI) / p.creditValuePaise)));
    out.packages.push({ id: p.id, milli, coveredPaise: take, valuePaise: packageValue(p, milli, take, pricePaise) });
    out.creditsMilli += milli;
    remaining -= take;
  }
  for (const l of lots) {
    if (remaining <= 0) break;
    const take = Math.min(l.remainingPaise, remaining);
    if (take <= 0) continue;
    out.lots.push({ id: l.id, amountPaise: take });
    out.walletPaise += take;
    remaining -= take;
  }
  out.duePaise = remaining;
  out.covered = pricePaise > 0 && remaining === 0;
  return out;
}

/** 1500 -> 1.5 */
export const toCredits = (milli: number) => milli / MILLI;

/** What the website sees of a package on sale. */
export type PublicPackageDTO = {
  id: string;
  name: string;
  /** Services it can pay for; empty means any. */
  serviceIds: string[];
  credits: number;
  /** Service price one credit covers, in paise. */
  creditValuePaise: number;
  /** What to charge, in paise. */
  pricePaise: number;
  /** pricePaise divided by credits. */
  perCreditPaise: number;
  validityDays: number | null;
};

export const toPublicPackage = (p: PackageDTO): PublicPackageDTO => ({
  id: p.id,
  name: p.name,
  serviceIds: p.serviceIds,
  credits: p.sessions,
  creditValuePaise: p.creditValuePaise,
  pricePaise: p.pricePaise,
  perCreditPaise: Math.round(p.pricePaise / p.sessions),
  validityDays: p.validityDays,
});

/** A purchase the website reported. `replayed` is true when the same Razorpay payment had already been recorded. */
export type PurchaseResultDTO = { purchaseId: string; kind: "package" | "wallet"; clientId: string; replayed: boolean };
