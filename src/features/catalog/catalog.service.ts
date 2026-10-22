import type { Actor } from "@/features/audit/audit.types";
import { DomainError } from "@/features/shared/errors";
import { isUuid } from "@/features/shared/validation";
import { paiseFromPrice, type ServiceDTO } from "./catalog.dto";
import type { CatalogRepository } from "./catalog.repository";
import { serviceInput, type ServiceInput } from "./catalog.schemas";

/** Services: what clients can book. */
export function createCatalogService({ catalogRepo }: { catalogRepo: CatalogRepository }) {
  async function get(id: string): Promise<ServiceDTO> {
    const row = isUuid(id) ? await catalogRepo.findById(id) : null;
    if (!row) throw new DomainError("not_found", `Service ${id} not found`);
    return row;
  }

  return {
    get,
    list: (opts?: { activeOnly?: boolean }) => catalogRepo.list(opts),

    async create(actor: Actor, input: ServiceInput): Promise<ServiceDTO> {
      const data = serviceInput.parse(input);
      return catalogRepo.create({ ...data, pricePaise: paiseFromPrice(data.priceDisplay) }, { actor, action: "create", entity: "service", details: { name: data.name } });
    },

    async update(actor: Actor, id: string, input: Partial<ServiceInput>): Promise<ServiceDTO> {
      const data = serviceInput.partial().parse(input);
      await get(id);
      // The online amount follows the price text whenever the price is edited.
      const withPaise = "priceDisplay" in data ? { ...data, pricePaise: paiseFromPrice(data.priceDisplay) } : data;
      const row = await catalogRepo.update(id, withPaise, { actor, action: "update", entity: "service", entityId: id, details: data });
      if (!row) throw new DomainError("not_found", `Service ${id} not found`);
      return row;
    },

    /**
     * Deletes a service nobody has booked. Bookings, packages and workflows keep pointing at the services they were made
     * for (history, credit, reminders), so while any do, the service can only be made not bookable.
     */
    async remove(actor: Actor, id: string) {
      const svc = await get(id);
      const used = await catalogRepo.usage(id);
      const times = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
      if (used.bookings) {
        throw new DomainError("conflict", `"${svc.name}" is in ${times(used.bookings, "booking")}, so it can't be deleted. Untick Bookable to hide it instead.`);
      }
      if (used.packages) {
        throw new DomainError("conflict", `"${svc.name}" is covered by ${times(used.packages, "package")}. Remove it from them first, or untick Bookable.`);
      }
      if (used.workflows) {
        throw new DomainError("conflict", `"${svc.name}" is chosen in ${times(used.workflows, "workflow")}. Remove it from them first, or untick Bookable.`);
      }
      await catalogRepo.remove(id, { actor, action: "delete", entity: "service", entityId: id });
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
