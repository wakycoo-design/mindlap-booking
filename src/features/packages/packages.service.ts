import type { Actor } from "@/features/audit/audit.types";
import { DomainError } from "@/features/shared/errors";
import { isUuid } from "@/features/shared/validation";
import type { ClientContact } from "@/features/clients/clients.dto";
import { WALLET_VALIDITY_DAYS, toPublicPackage, type PackageDTO } from "./packages.dto";
import type { PackagesRepository } from "./packages.repository";
import { packageInput, packagePurchaseInput, sellInput, topUpInput, walletTopUpInput } from "./packages.schemas";

const DAY = 86_400_000;
/** Marks a package made for one price tier, e.g. "4 session individual therapy · ₹7,000 tier". */
export const TIER_SUFFIX = / · ₹[\d,]+ tier$/;

/** The form a website sends a client in, as the stored contact. */
const toContact = (c: { name: string; phone: string; email?: string | null; whatsappOptIn: boolean }): ClientContact => ({
  name: c.name,
  phoneE164: c.phone,
  email: c.email ?? null,
  whatsappOptIn: c.whatsappOptIn,
});

/**
 * Packages (a number of sessions for one price) and wallet money (rupees paid in advance). Spending and giving
 * back credit happens inside the booking's own transaction (see packages.repository); this service is the
 * staff-facing side: what is on sale, what each client holds.
 */
export function createPackagesService(deps: {
  packagesRepo: PackagesRepository;
  /** What a service costs with a given person (their own price if they have one), for quotes. */
  priceFor: (serviceId: string, staffId: string | null) => Promise<{ serviceName: string; owes: boolean; pricePaise: number | null }>;
  /** Every price (paise) the people offering these services charge for them. Empty means any service. */
  pricesFor: (serviceIds: string[]) => Promise<number[]>;
}) {
  const { packagesRepo, priceFor, pricesFor } = deps;

  async function checkServices(serviceIds: string[]) {
    if (!serviceIds.length) return;
    const known = await packagesRepo.knownServiceIds();
    const missing = serviceIds.filter((id) => !known.has(id));
    if (missing.length) throw new DomainError("invalid", `Service ${missing.join(", ")} not found`);
  }

  async function get(id: string): Promise<PackageDTO> {
    const row = isUuid(id) ? await packagesRepo.findById(id) : null;
    if (!row) throw new DomainError("not_found", `Package ${id} not found`);
    return row;
  }

  async function requireClient(clientId: string) {
    if (!isUuid(clientId) || !(await packagesRepo.clientExists(clientId))) throw new DomainError("not_found", `Client ${clientId} not found`);
  }

  return {
    get,
    list: () => packagesRepo.list(),

    async create(actor: Actor, input: unknown) {
      const data = packageInput.parse(input);
      await checkServices(data.serviceIds);
      return packagesRepo.create(data, { actor, action: "create", entity: "package" });
    },

    async update(actor: Actor, id: string, input: unknown) {
      const data = packageInput.parse(input);
      await get(id);
      await checkServices(data.serviceIds);
      // Clients who already bought it keep the sessions, price and expiry they bought with.
      return (await packagesRepo.update(id, data, { actor, action: "update", entity: "package", entityId: id }))!;
    },

    /** Records that a client bought a package. Payment itself is taken outside the app; the note says how. */
    async sell(actor: Actor, clientId: string, input: unknown, now = new Date()) {
      const data = sellInput.parse(input);
      await requireClient(clientId);
      const pkg = await get(data.packageId);
      if (!pkg.active) throw new DomainError("invalid", `Package "${pkg.name}" is not on sale`);
      const expiresAt = pkg.validityDays ? new Date(now.getTime() + pkg.validityDays * DAY) : null;
      return packagesRepo.sell(clientId, pkg, { expiresAt, paymentNote: data.paymentNote ?? null }, { actor, action: "sell_package", entity: "client_package" });
    },

    /** Adds wallet money. It is spent oldest-first and each top-up expires a year after it was added. */
    async topUp(actor: Actor, clientId: string, input: unknown, now = new Date()) {
      const data = topUpInput.parse(input);
      await requireClient(clientId);
      return packagesRepo.topUp(
        clientId,
        { amountPaise: data.amountPaise, expiresAt: new Date(now.getTime() + WALLET_VALIDITY_DAYS * DAY), note: data.note ?? null },
        { actor, action: "wallet_top_up", entity: "wallet_lot" },
      );
    },

    /**
     * How a booking of this service would be paid from the client's credit right now, without taking anything. Lets the
     * website show "this costs 1.5 credits" or "₹500 left to pay" before the client commits. It matches what booking does.
     */
    async quote(clientId: string, input: { serviceId: string; staffId?: string | null }, now = new Date()) {
      await requireClient(clientId);
      const price = await priceFor(input.serviceId, input.staffId ?? null);
      const plan = await packagesRepo.quote(clientId, { serviceId: input.serviceId, owes: price.owes, pricePaise: price.pricePaise, now });
      return { serviceName: price.serviceName, pricePaise: price.pricePaise, plan };
    },

    /**
     * Keeps a package for every price a therapist charges. Each package the firm made itself (on sale, not a tier) is
     * repeated at every therapist price for its services with the same discount: "4 sessions for ₹3,600" at the ₹1,000
     * tier (10% off) becomes "4 sessions for ₹25,200" at ₹7,000, so one credit covers one session with that therapist.
     * Tiers nobody charges any more go off sale (buyers keep their credits) and come back if the price does. Packages the
     * firm made by hand are never changed, and a tier's price edited by hand is kept.
     */
    async syncPriceTiers(actor: Actor) {
      const all = await packagesRepo.list();
      const sameServices = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
      const isTier = (p: PackageDTO) => TIER_SUFFIX.test(p.name);
      const result = { created: [] as PackageDTO[], retired: [] as PackageDTO[], restored: [] as PackageDTO[] };
      const wanted = new Set<string>();
      const toData = (p: PackageDTO, active: boolean) => packageInput.parse({ ...p, active });
      for (const template of all.filter((p) => p.active && !isTier(p))) {
        const full = template.sessions * template.creditValuePaise;
        const share = full > 0 ? template.pricePaise / full : 1;
        for (const price of await pricesFor(template.serviceIds)) {
          if (price <= 0 || price === template.creditValuePaise) continue;
          const match = [...all, ...result.created].find(
            (p) => p.sessions === template.sessions && p.creditValuePaise === price && sameServices(p.serviceIds, template.serviceIds),
          );
          if (match) {
            wanted.add(match.id);
            if (isTier(match) && !match.active) {
              result.restored.push((await packagesRepo.update(match.id, toData(match, true), { actor, action: "update", entity: "package", entityId: match.id }))!);
            }
            continue;
          }
          const data = packageInput.parse({
            name: `${template.name} · ₹${(price / 100).toLocaleString("en-IN")} tier`,
            serviceIds: template.serviceIds,
            sessions: template.sessions,
            creditValuePaise: price,
            validityDays: template.validityDays,
            // Whole rupees, so the price reads cleanly on the site and in Razorpay.
            pricePaise: Math.round((template.sessions * price * share) / 100) * 100,
          });
          const made = await packagesRepo.create(data, { actor, action: "create", entity: "package" });
          result.created.push(made);
          wanted.add(made.id);
        }
      }
      for (const p of all.filter((p) => isTier(p) && p.active && !wanted.has(p.id))) {
        result.retired.push((await packagesRepo.update(p.id, toData(p, false), { actor, action: "update", entity: "package", entityId: p.id }))!);
      }
      return result;
    },

    /** Packages the website may sell: only those on sale. */
    async onSale() {
      return (await packagesRepo.list()).filter((p) => p.active).map(toPublicPackage);
    },

    /**
     * The website sold a package through Razorpay and tells us. The amount must be the package's price. The buyer is found
     * by phone (and created if new). Reporting the same Razorpay payment again changes nothing and says so.
     */
    async purchasePackage(actor: Actor, packageId: string, input: unknown, now = new Date()) {
      const data = packagePurchaseInput.parse(input);
      const pkg = await get(packageId);
      if (!pkg.active) throw new DomainError("conflict", `Package "${pkg.name}" is not on sale`, { reason: "package_not_on_sale" });
      if (data.currency !== "INR") throw new DomainError("invalid", "Only INR payments are supported");
      if (data.amountPaise !== pkg.pricePaise) {
        throw new DomainError("invalid", `Amount ${data.amountPaise} paise does not match the package price of ${pkg.pricePaise} paise`, {
          reason: "amount_mismatch",
          expectedPaise: pkg.pricePaise,
        });
      }
      return packagesRepo.recordPurchase(
        {
          kind: "package",
          client: toContact(data.client),
          amountPaise: data.amountPaise,
          currency: data.currency,
          razorpayOrderId: data.razorpayOrderId ?? null,
          razorpayPaymentId: data.razorpayPaymentId,
          method: data.method ?? null,
          paidAt: data.paidAt ?? now,
          pkg,
          expiresAt: pkg.validityDays ? new Date(now.getTime() + pkg.validityDays * DAY) : null,
        },
        { actor, action: "package_purchase", entity: "credit_purchase" },
      );
    },

    /** The website took money into the client's wallet through Razorpay. The client gets exactly the amount paid. */
    async topUpFromPayment(actor: Actor, input: unknown, now = new Date()) {
      const data = walletTopUpInput.parse(input);
      if (data.currency !== "INR") throw new DomainError("invalid", "Only INR payments are supported");
      return packagesRepo.recordPurchase(
        {
          kind: "wallet",
          client: toContact(data.client),
          amountPaise: data.amountPaise,
          currency: data.currency,
          razorpayOrderId: data.razorpayOrderId ?? null,
          razorpayPaymentId: data.razorpayPaymentId,
          method: data.method ?? null,
          paidAt: data.paidAt ?? now,
          expiresAt: new Date(now.getTime() + WALLET_VALIDITY_DAYS * DAY),
        },
        { actor, action: "wallet_top_up_payment", entity: "credit_purchase" },
      );
    },

    async summary(clientId: string, now = new Date()) {
      await requireClient(clientId);
      return packagesRepo.summary(clientId, now);
    },

    /** Credits looked up by the client's phone number, for the website. Unknown numbers simply have none. */
    allPackages: (clientId: string) => packagesRepo.allPackages(clientId),
    allLots: (clientId: string) => packagesRepo.allLots(clientId),
    usesForBooking: (bookingId: string) => packagesRepo.uses({ bookingId }),
    usesForClient: (clientId: string, limit = 50) => packagesRepo.uses({ clientId }, limit),
  };
}

export type PackagesService = ReturnType<typeof createPackagesService>;
