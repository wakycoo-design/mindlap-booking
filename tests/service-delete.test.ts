import { beforeEach, describe, expect, it } from "vitest";
import { c, reset } from "./helpers";
import { zonedToUtc } from "@/lib/time";

beforeEach(reset);

const nextWeek = (time: string) =>
  zonedToUtc(`${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)}T${time}`, "Asia/Kolkata");

async function offered(name: string) {
  const svc = await c.catalog.create({}, { name, durationMin: 60, priceDisplay: "1000" });
  const asha = await c.staff.create({}, { name: `Asha ${name}`, email: `asha-${name.toLowerCase().replace(/\W/g, "")}@firm.test` });
  await c.staff.setServices({}, asha.id, [svc.id]);
  await c.schedules.setWeeklyHours({}, asha.id, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })));
  return { svc, asha };
}

describe("deleting a service", () => {
  it("removes a service nobody booked, with who offered it", async () => {
    const { svc, asha } = await offered("Trial");
    await c.catalog.remove({}, svc.id);
    await expect(c.catalog.get(svc.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await c.staff.listBookableForService(svc.id)).toEqual([]);
    expect((await c.staff.get(asha.id)).active).toBe(true);
  });

  it("refuses while a booking, package or workflow uses it", async () => {
    const booked = await offered("Booked");
    await c.bookings.create({ mode: "staff" }, { serviceId: booked.svc.id, start: nextWeek("10:00").toISOString(), client: { name: "Ravi", phone: "98765 43210" } });
    await expect(c.catalog.remove({}, booked.svc.id)).rejects.toMatchObject({ code: "conflict" });

    const packaged = await offered("Packaged");
    await c.packages.create({}, { name: "4 sessions", serviceIds: [packaged.svc.id], sessions: 4, pricePaise: 360000 });
    await expect(c.catalog.remove({}, packaged.svc.id)).rejects.toMatchObject({ code: "conflict" });

    const reminded = await offered("Reminded");
    await c.workflows.create({}, {
      name: "Confirm",
      trigger: "booked",
      serviceIds: [reminded.svc.id],
      action: { channel: "email", recipient: "client", subject: "ok", body: "booked" },
    });
    await expect(c.catalog.remove({}, reminded.svc.id)).rejects.toMatchObject({ code: "conflict" });

    // Still there, just as before.
    expect((await c.catalog.get(booked.svc.id)).active).toBe(true);
  });
});
