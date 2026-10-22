import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { booking, service, servicePackage, workflow } from "@/db/schema";
import { writeAudit } from "@/features/audit/audit.repository";
import type { AuditEntry } from "@/features/audit/audit.types";
import type { ServiceDTO } from "./catalog.dto";
import type { ServiceData } from "./catalog.schemas";

const columns = {
  id: service.id,
  name: service.name,
  description: service.description,
  durationMin: service.durationMin,
  bufferBeforeMin: service.bufferBeforeMin,
  bufferAfterMin: service.bufferAfterMin,
  priceDisplay: service.priceDisplay,
  pricePaise: service.pricePaise,
  slotIntervalMin: service.slotIntervalMin,
  minNoticeMin: service.minNoticeMin,
  maxNoticeDays: service.maxNoticeDays,
  maxPerDay: service.maxPerDay,
  location: service.location,
  meetingType: service.meetingType,
  questions: service.questions,
  active: service.active,
};

export function createCatalogRepository(db: Db) {
  return {
    async findById(id: string): Promise<ServiceDTO | null> {
      const [row] = await db.select(columns).from(service).where(eq(service.id, id));
      return row ?? null;
    },

    list({ activeOnly = false } = {}): Promise<ServiceDTO[]> {
      const q = db.select(columns).from(service);
      return (activeOnly ? q.where(eq(service.active, true)) : q).orderBy(asc(service.name));
    },

    create(data: ServiceData & { pricePaise: number | null }, audit: Omit<AuditEntry, "entityId">): Promise<ServiceDTO> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(service).values(data).returning(columns);
        await writeAudit(tx, { ...audit, entityId: row.id });
        return row;
      });
    },

    /** What still points at a service: bookings (past or future), packages that cover it, workflows limited to it. */
    async usage(id: string): Promise<{ bookings: number; packages: number; workflows: number }> {
      const count = sql<number>`count(*)::int`;
      const [[b], [p], [w]] = await Promise.all([
        db.select({ n: count }).from(booking).where(eq(booking.serviceId, id)),
        db.select({ n: count }).from(servicePackage).where(sql`${id}::uuid = any(${servicePackage.serviceIds})`),
        db.select({ n: count }).from(workflow).where(sql`${id}::uuid = any(${workflow.serviceIds})`),
      ]);
      return { bookings: b?.n ?? 0, packages: p?.n ?? 0, workflows: w?.n ?? 0 };
    },

    /** Deletes the service; who offers it and any open holds on it go with it (cascade). */
    remove(id: string, audit: AuditEntry): Promise<void> {
      return db.transaction(async (tx) => {
        await tx.delete(service).where(eq(service.id, id));
        await writeAudit(tx, audit);
      });
    },

    update(id: string, data: Partial<ServiceData> & { pricePaise?: number | null }, audit: AuditEntry): Promise<ServiceDTO | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(service).set(data).where(eq(service.id, id)).returning(columns);
        if (row) await writeAudit(tx, audit);
        return row ?? null;
      });
    },
  };
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;
