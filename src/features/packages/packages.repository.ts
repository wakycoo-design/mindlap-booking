import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@/db";
import { booking, client, clientPackage, creditPurchase, creditUse, service, servicePackage, walletLot } from "@/db/schema";
import { writeAudit } from "@/features/audit/audit.repository";
import type { AuditEntry } from "@/features/audit/audit.types";
import type { ClientContact } from "@/features/clients/clients.dto";
import { upsertClient } from "@/features/clients/clients.repository";
import { PG_UNIQUE_VIOLATION, pgError } from "@/features/shared/db-errors";
import {
  allocate,
  toCredits,
  MILLI,
  type Allocation,
  type ClientPackageDTO,
  type CreditSummaryDTO,
  type CreditTaken,
  type CreditUseDTO,
  type PackageDTO,
  type PurchaseResultDTO,
  type WalletLotDTO,
} from "./packages.dto";
import type { PackageData } from "./packages.schemas";

const packageColumns = {
  id: servicePackage.id,
  name: servicePackage.name,
  serviceIds: servicePackage.serviceIds,
  sessions: servicePackage.sessions,
  creditValuePaise: servicePackage.creditValuePaise,
  validityDays: servicePackage.validityDays,
  pricePaise: servicePackage.pricePaise,
  active: servicePackage.active,
  retiredAutomatically: servicePackage.retiredAutomatically,
};

const clientPackageColumns = {
  id: clientPackage.id,
  clientId: clientPackage.clientId,
  packageId: clientPackage.packageId,
  packageName: servicePackage.name,
  serviceIds: servicePackage.serviceIds,
  totalMilli: clientPackage.creditsTotalMilli,
  leftMilli: clientPackage.creditsLeftMilli,
  creditValuePaise: clientPackage.creditValuePaise,
  pricePaise: clientPackage.pricePaise,
  valueLeftPaise: clientPackage.valueLeftPaise,
  expiresAt: clientPackage.expiresAt,
  paymentNote: clientPackage.paymentNote,
  createdAt: clientPackage.createdAt,
};

type PackageRow = {
  id: string;
  clientId: string;
  packageId: string;
  packageName: string;
  serviceIds: string[];
  totalMilli: number;
  leftMilli: number;
  creditValuePaise: number;
  pricePaise: number;
  valueLeftPaise: number;
  expiresAt: Date | null;
  paymentNote: string | null;
  createdAt: Date;
};

const toPackageDto = ({ totalMilli, leftMilli, ...r }: PackageRow): ClientPackageDTO => ({
  ...r,
  creditsTotal: toCredits(totalMilli),
  creditsLeft: toCredits(leftMilli),
});

const lotColumns = {
  id: walletLot.id,
  amountPaise: walletLot.amountPaise,
  remainingPaise: walletLot.remainingPaise,
  expiresAt: walletLot.expiresAt,
  note: walletLot.note,
  createdAt: walletLot.createdAt,
};

/**
 * The client's spendable credit for a service: packages that cover it and haven't expired (soonest expiry first),
 * and wallet lots (soonest expiry first). With `lock`, the rows are locked until the transaction ends, so two
 * bookings made at the same moment can never spend the same credit twice.
 */
async function balances(tx: DbOrTx, clientId: string, serviceId: string, now: Date, lock: boolean) {
  const pkgQuery = tx
    .select({ ...clientPackageColumns })
    .from(clientPackage)
    .innerJoin(servicePackage, eq(servicePackage.id, clientPackage.packageId))
    .where(
      and(
        eq(clientPackage.clientId, clientId),
        gt(clientPackage.creditsLeftMilli, 0),
        or(isNull(clientPackage.expiresAt), gt(clientPackage.expiresAt, now)),
        sql`(cardinality(${servicePackage.serviceIds}) = 0 or ${serviceId}::uuid = any(${servicePackage.serviceIds}))`,
      ),
    )
    .orderBy(sql`${clientPackage.expiresAt} asc nulls last`, asc(clientPackage.createdAt));
  const lotQuery = tx
    .select({ id: walletLot.id, remainingPaise: walletLot.remainingPaise })
    .from(walletLot)
    .where(and(eq(walletLot.clientId, clientId), gt(walletLot.remainingPaise, 0), gt(walletLot.expiresAt, now)))
    .orderBy(asc(walletLot.expiresAt), asc(walletLot.createdAt));
  const [packages, lots] = await Promise.all([
    lock ? pkgQuery.for("update", { of: clientPackage }) : pkgQuery,
    lock ? lotQuery.for("update") : lotQuery,
  ]);
  return { packages, lots };
}

/** How a price would be paid from this client's credit right now. Reads only, for quotes. */
export async function quoteCredits(db: DbOrTx, t: { clientId: string; serviceId: string; owes: boolean; pricePaise: number | null; now: Date }): Promise<Allocation> {
  const { packages, lots } = await balances(db, t.clientId, t.serviceId, t.now, false);
  return allocate(t.owes ? t.pricePaise : 0, t.owes ? packages.map(toBalance) : [], t.owes ? lots : []);
}

const toBalance = (p: PackageRow) => ({ id: p.id, leftMilli: p.leftMilli, totalMilli: p.totalMilli, creditValuePaise: p.creditValuePaise, pricePaise: p.pricePaise, valueLeftPaise: p.valueLeftPaise });

/**
 * Spends credit for a booking, inside the booking's own transaction so the booking and what paid for it succeed
 * or fail together. See `allocate` for the order and the amounts.
 */
export async function applyCredits(
  tx: Tx,
  t: { bookingId: string; clientId: string; serviceId: string; owes: boolean; pricePaise: number | null; now: Date },
): Promise<Allocation> {
  if (!t.owes) return allocate(0, [], []);
  const { packages, lots } = await balances(tx, t.clientId, t.serviceId, t.now, true);
  const plan = allocate(t.pricePaise, packages.map(toBalance), lots);
  for (const p of plan.packages) {
    await tx
      .update(clientPackage)
      .set({ creditsLeftMilli: sql`${clientPackage.creditsLeftMilli} - ${p.milli}`, valueLeftPaise: sql`${clientPackage.valueLeftPaise} - ${p.valuePaise}` })
      .where(eq(clientPackage.id, p.id));
    await tx.insert(creditUse).values({ bookingId: t.bookingId, clientPackageId: p.id, creditsMilli: p.milli, coveredPaise: p.coveredPaise, valuePaise: p.valuePaise });
  }
  for (const l of plan.lots) {
    await tx.update(walletLot).set({ remainingPaise: sql`${walletLot.remainingPaise} - ${l.amountPaise}` }).where(eq(walletLot.id, l.id));
    await tx.insert(creditUse).values({ bookingId: t.bookingId, walletLotId: l.id, amountPaise: l.amountPaise, coveredPaise: l.amountPaise, valuePaise: l.amountPaise });
  }
  if (plan.creditsMilli || plan.walletPaise) {
    await tx.update(booking).set({ creditMilli: plan.creditsMilli, creditPaise: plan.walletPaise }).where(eq(booking.id, t.bookingId));
  }
  return plan;
}

/**
 * Gives back whatever a booking took. Credits or money whose package or lot has expired in the meantime are not
 * restored (they would be unusable), but the use is still marked returned so it is never handled twice.
 */
export async function returnCredits(tx: Tx, bookingId: string, now: Date): Promise<CreditTaken> {
  const uses = await tx
    .select({ id: creditUse.id, packageId: creditUse.clientPackageId, lotId: creditUse.walletLotId, milli: creditUse.creditsMilli, amount: creditUse.amountPaise, value: creditUse.valuePaise })
    .from(creditUse)
    .where(and(eq(creditUse.bookingId, bookingId), isNull(creditUse.returnedAt)))
    .for("update");
  const back: CreditTaken = { credits: 0, walletPaise: 0 };
  for (const u of uses) {
    if (u.packageId) {
      const restored = await tx
        .update(clientPackage)
        .set({ creditsLeftMilli: sql`${clientPackage.creditsLeftMilli} + ${u.milli}`, valueLeftPaise: sql`${clientPackage.valueLeftPaise} + ${u.value}` })
        .where(and(eq(clientPackage.id, u.packageId), or(isNull(clientPackage.expiresAt), gt(clientPackage.expiresAt, now))))
        .returning({ id: clientPackage.id });
      if (restored.length) back.credits += toCredits(u.milli);
    } else if (u.lotId) {
      const restored = await tx
        .update(walletLot)
        .set({ remainingPaise: sql`${walletLot.remainingPaise} + ${u.amount}` })
        .where(and(eq(walletLot.id, u.lotId), gt(walletLot.expiresAt, now)))
        .returning({ id: walletLot.id });
      if (restored.length) back.walletPaise += u.amount;
    }
    await tx.update(creditUse).set({ returnedAt: now }).where(eq(creditUse.id, u.id));
  }
  if (uses.length) await tx.update(booking).set({ creditMilli: 0, creditPaise: 0 }).where(eq(booking.id, bookingId));
  return back;
}

/** A moved booking is a new row; what paid for the old one now pays for the new one. */
export async function moveCredits(tx: Tx, fromBookingId: string, toBookingId: string) {
  await tx.update(creditUse).set({ bookingId: toBookingId }).where(and(eq(creditUse.bookingId, fromBookingId), isNull(creditUse.returnedAt)));
  const [old] = await tx.select({ m: booking.creditMilli, p: booking.creditPaise }).from(booking).where(eq(booking.id, fromBookingId));
  if (old) {
    await tx.update(booking).set({ creditMilli: old.m, creditPaise: old.p }).where(eq(booking.id, toBookingId));
    await tx.update(booking).set({ creditMilli: 0, creditPaise: 0 }).where(eq(booking.id, fromBookingId));
  }
}

export function createPackagesRepository(db: Db) {
  return {
    list(): Promise<PackageDTO[]> {
      return db.select(packageColumns).from(servicePackage).orderBy(desc(servicePackage.active), asc(servicePackage.name));
    },

    async findById(id: string): Promise<PackageDTO | null> {
      const [row] = await db.select(packageColumns).from(servicePackage).where(eq(servicePackage.id, id));
      return row ?? null;
    },

    create(data: PackageData, audit: Omit<AuditEntry, "entityId">): Promise<PackageDTO> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(servicePackage).values(data).returning(packageColumns);
        await writeAudit(tx, { ...audit, entityId: row.id });
        return row;
      });
    },

    update(id: string, data: PackageData, audit: AuditEntry): Promise<PackageDTO | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(servicePackage).set(data).where(eq(servicePackage.id, id)).returning(packageColumns);
        if (row) await writeAudit(tx, audit);
        return row ?? null;
      });
    },

    /** How many times clients bought this package (bought packages can't be deleted: they hold credit and history). */
    async timesSold(id: string): Promise<number> {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(clientPackage).where(eq(clientPackage.packageId, id));
      return row?.n ?? 0;
    },

    remove(id: string, audit: AuditEntry): Promise<void> {
      return db.transaction(async (tx) => {
        await tx.delete(servicePackage).where(eq(servicePackage.id, id));
        await writeAudit(tx, audit);
      });
    },

    async knownServiceIds(): Promise<Set<string>> {
      return new Set((await db.select({ id: service.id }).from(service)).map((r) => r.id));
    },

    /** Records a sale: the client now holds the package's credits, priced and dated as of today. */
    sell(clientId: string, pkg: PackageDTO, v: { expiresAt: Date | null; paymentNote: string | null }, audit: Omit<AuditEntry, "entityId">): Promise<string> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(clientPackage)
          .values({
            clientId,
            packageId: pkg.id,
            creditsTotalMilli: pkg.sessions * MILLI,
            creditsLeftMilli: pkg.sessions * MILLI,
            creditValuePaise: pkg.creditValuePaise,
            pricePaise: pkg.pricePaise,
            valueLeftPaise: pkg.pricePaise,
            expiresAt: v.expiresAt,
            paymentNote: v.paymentNote,
          })
          .returning({ id: clientPackage.id });
        await writeAudit(tx, { ...audit, entityId: row.id, details: { ...audit.details, clientId, packageId: pkg.id, pricePaise: pkg.pricePaise } });
        return row.id;
      });
    },

    /**
     * Records a package or wallet top-up the website sold. All in one transaction: the client (created if new), the
     * credit, and the payment record. A payment id already recorded returns that purchase instead of crediting twice.
     */
    async recordPurchase(
      p: {
        kind: "package" | "wallet";
        client: ClientContact;
        amountPaise: number;
        currency: string;
        razorpayOrderId: string | null;
        razorpayPaymentId: string;
        method: string | null;
        paidAt: Date;
        pkg?: PackageDTO;
        expiresAt: Date | null;
      },
      audit: Omit<AuditEntry, "entityId">,
    ): Promise<PurchaseResultDTO> {
      const existing = async () => {
        const [row] = await db
          .select({ id: creditPurchase.id, kind: creditPurchase.kind, clientId: creditPurchase.clientId })
          .from(creditPurchase)
          .where(eq(creditPurchase.razorpayPaymentId, p.razorpayPaymentId));
        return row ? ({ purchaseId: row.id, kind: row.kind as "package" | "wallet", clientId: row.clientId, replayed: true } satisfies PurchaseResultDTO) : null;
      };
      const seen = await existing();
      if (seen) return seen;
      try {
        return await db.transaction(async (tx) => {
          const clientId = await upsertClient(tx, p.client);
          let packageId: string | null = null;
          let lotId: string | null = null;
          if (p.kind === "package") {
            const pkg = p.pkg!;
            [{ id: packageId }] = await tx
              .insert(clientPackage)
              .values({
                clientId,
                packageId: pkg.id,
                creditsTotalMilli: pkg.sessions * MILLI,
                creditsLeftMilli: pkg.sessions * MILLI,
                creditValuePaise: pkg.creditValuePaise,
                pricePaise: pkg.pricePaise,
                valueLeftPaise: pkg.pricePaise,
                expiresAt: p.expiresAt,
                paymentNote: `Razorpay ${p.razorpayPaymentId}`,
              })
              .returning({ id: clientPackage.id });
          } else {
            [{ id: lotId }] = await tx
              .insert(walletLot)
              .values({ clientId, amountPaise: p.amountPaise, remainingPaise: p.amountPaise, expiresAt: p.expiresAt!, note: `Razorpay ${p.razorpayPaymentId}` })
              .returning({ id: walletLot.id });
          }
          const [row] = await tx
            .insert(creditPurchase)
            .values({
              clientId,
              kind: p.kind,
              clientPackageId: packageId,
              walletLotId: lotId,
              amountPaise: p.amountPaise,
              currency: p.currency,
              razorpayOrderId: p.razorpayOrderId,
              razorpayPaymentId: p.razorpayPaymentId,
              method: p.method,
              paidAt: p.paidAt,
            })
            .returning({ id: creditPurchase.id });
          await writeAudit(tx, { ...audit, entityId: row.id, details: { ...audit.details, clientId, kind: p.kind, amountPaise: p.amountPaise } });
          return { purchaseId: row.id, kind: p.kind, clientId, replayed: false };
        });
      } catch (err) {
        // Two reports of the same payment raced: the other one won, so report what it recorded.
        if (pgError(err).code === PG_UNIQUE_VIOLATION && pgError(err).constraint?.includes("razorpay_payment_id")) {
          const again = await existing();
          if (again) return again;
        }
        throw err;
      }
    },

    topUp(clientId: string, v: { amountPaise: number; expiresAt: Date; note: string | null }, audit: Omit<AuditEntry, "entityId">): Promise<string> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(walletLot)
          .values({ clientId, amountPaise: v.amountPaise, remainingPaise: v.amountPaise, expiresAt: v.expiresAt, note: v.note })
          .returning({ id: walletLot.id });
        await writeAudit(tx, { ...audit, entityId: row.id, details: { ...audit.details, clientId, amountPaise: v.amountPaise } });
        return row.id;
      });
    },

    /** Everything this client can still spend at `now`, on any service. */
    async summary(clientId: string, now: Date): Promise<CreditSummaryDTO> {
      const [packages, lots] = await Promise.all([
        db
          .select(clientPackageColumns)
          .from(clientPackage)
          .innerJoin(servicePackage, eq(servicePackage.id, clientPackage.packageId))
          .where(and(eq(clientPackage.clientId, clientId), gt(clientPackage.creditsLeftMilli, 0), or(isNull(clientPackage.expiresAt), gt(clientPackage.expiresAt, now))))
          .orderBy(sql`${clientPackage.expiresAt} asc nulls last`, asc(clientPackage.createdAt)),
        db
          .select(lotColumns)
          .from(walletLot)
          .where(and(eq(walletLot.clientId, clientId), gt(walletLot.remainingPaise, 0), gt(walletLot.expiresAt, now)))
          .orderBy(asc(walletLot.expiresAt), asc(walletLot.createdAt)),
      ]);
      const dtos = packages.map(toPackageDto);
      const walletPaise = lots.reduce((n, l) => n + l.remainingPaise, 0);
      const packageValuePaise = dtos.reduce((n, p) => n + p.valueLeftPaise, 0);
      return { packages: dtos, lots, walletPaise, packageValuePaise, totalPaise: walletPaise + packageValuePaise };
    },

    /** How a booking of this price would be paid from the client's credit, without taking anything. */
    quote: (clientId: string, t: { serviceId: string; owes: boolean; pricePaise: number | null; now: Date }) => quoteCredits(db, { clientId, ...t }),

    /** Every package the client has bought, including used-up and expired ones. */
    async allPackages(clientId: string): Promise<ClientPackageDTO[]> {
      return (
        await db
          .select(clientPackageColumns)
          .from(clientPackage)
          .innerJoin(servicePackage, eq(servicePackage.id, clientPackage.packageId))
          .where(eq(clientPackage.clientId, clientId))
          .orderBy(desc(clientPackage.createdAt))
      ).map(toPackageDto);
    },

    allLots(clientId: string): Promise<WalletLotDTO[]> {
      return db.select(lotColumns).from(walletLot).where(eq(walletLot.clientId, clientId)).orderBy(desc(walletLot.createdAt));
    },

    /** What one booking, or a client's recent bookings, were paid with. */
    async uses(filter: { bookingId?: string; clientId?: string }, limit = 50): Promise<CreditUseDTO[]> {
      const rows = await db
        .select({
          id: creditUse.id,
          bookingId: creditUse.bookingId,
          bookingNumber: booking.number,
          kind: sql<"package" | "wallet">`case when ${creditUse.clientPackageId} is not null then 'package' else 'wallet' end`,
          label: sql<string>`coalesce(${servicePackage.name}, 'Wallet')`,
          milli: creditUse.creditsMilli,
          coveredPaise: creditUse.coveredPaise,
          amountPaise: creditUse.amountPaise,
          valuePaise: creditUse.valuePaise,
          returnedAt: creditUse.returnedAt,
          createdAt: creditUse.createdAt,
        })
        .from(creditUse)
        .innerJoin(booking, eq(booking.id, creditUse.bookingId))
        .leftJoin(clientPackage, eq(clientPackage.id, creditUse.clientPackageId))
        .leftJoin(servicePackage, eq(servicePackage.id, clientPackage.packageId))
        .where(
          and(
            filter.bookingId ? eq(creditUse.bookingId, filter.bookingId) : undefined,
            filter.clientId ? eq(booking.clientId, filter.clientId) : undefined,
          ),
        )
        .orderBy(desc(creditUse.createdAt))
        .limit(limit);
      return rows.map(({ milli, ...r }) => ({ ...r, credits: toCredits(milli) }));
    },

    async clientExists(id: string): Promise<boolean> {
      const [row] = await db.select({ id: client.id }).from(client).where(eq(client.id, id));
      return Boolean(row);
    },
  };
}

export type PackagesRepository = ReturnType<typeof createPackagesRepository>;
