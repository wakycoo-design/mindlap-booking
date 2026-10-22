import { beforeEach, describe, expect, it } from "vitest";
import { c, reset } from "./helpers";

beforeEach(reset);

// Mindlap's price list: individual ₹1,000 a session (4 = ₹3,600, 8 = ₹6,800, 12 = ₹9,600),
// couple ₹1,500 a session (4 = ₹5,400, 12 = ₹14,400).
async function setup() {
  const individual = await c.catalog.create({}, { name: "Individual therapy", durationMin: 60, priceDisplay: "1000" });
  const couple = await c.catalog.create({}, { name: "Couple therapy", durationMin: 60, priceDisplay: "1500" });
  const rishin = await c.staff.create({}, { name: "Rishin", email: "rishin@firm.test" });
  const senior = await c.staff.create({}, { name: "Senior", email: "senior@firm.test" });
  for (const s of [rishin, senior]) await c.staff.setServices({}, s.id, [individual.id, couple.id]);
  await c.staff.setServicePrices({}, senior.id, { [individual.id]: 700000, [couple.id]: 900000 });
  const base = [
    [individual.id, 4, 100000, 360000],
    [individual.id, 8, 100000, 680000],
    [individual.id, 12, 100000, 960000],
    [couple.id, 4, 150000, 540000],
    [couple.id, 12, 150000, 1440000],
  ] as const;
  for (const [serviceId, sessions, creditValuePaise, pricePaise] of base) {
    await c.packages.create({}, { name: `${sessions} session package`, serviceIds: [serviceId], sessions, creditValuePaise, pricePaise });
  }
  return { individual, couple };
}

describe("price-tier packages", () => {
  it("repeat each package at every therapist's price with the same discount", async () => {
    const { individual, couple } = await setup();
    const created = await c.packages.createPriceTiers({});
    expect(created).toHaveLength(5); // one new tier (the ₹7,000 / ₹9,000 therapist) per base package
    const tier = (serviceId: string, sessions: number) =>
      created.find((p) => p.serviceIds[0] === serviceId && p.sessions === sessions);
    // ₹7,000 individual: 4 × 10% off, 8 × 15% off, 12 × 20% off.
    expect(tier(individual.id, 4)).toMatchObject({ creditValuePaise: 700000, pricePaise: 2520000, name: "4 session package · ₹7,000 tier" });
    expect(tier(individual.id, 8)).toMatchObject({ creditValuePaise: 700000, pricePaise: 4760000 });
    expect(tier(individual.id, 12)).toMatchObject({ creditValuePaise: 700000, pricePaise: 6720000 });
    // ₹9,000 couple keeps the couple discounts.
    expect(tier(couple.id, 4)).toMatchObject({ creditValuePaise: 900000, pricePaise: 3240000 });
    expect(tier(couple.id, 12)).toMatchObject({ creditValuePaise: 900000, pricePaise: 8640000 });
  });

  it("add nothing the second time, and only the missing tier after a price changes", async () => {
    const { individual } = await setup();
    await c.packages.createPriceTiers({});
    expect(await c.packages.createPriceTiers({})).toEqual([]);
    const senior = (await c.staff.list()).find((s) => s.name === "Senior")!;
    await c.staff.setServicePrices({}, senior.id, { [individual.id]: 500000 });
    const added = await c.packages.createPriceTiers({});
    expect(added.map((p) => [p.sessions, p.creditValuePaise, p.pricePaise]).sort((a, b) => a[0] - b[0])).toEqual([
      [4, 500000, 1800000],
      [8, 500000, 3400000],
      [12, 500000, 4800000],
    ]);
  });
});
