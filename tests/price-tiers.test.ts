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
    const { created } = await c.packages.syncPriceTiers({});
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
    await c.packages.syncPriceTiers({});
    expect(await c.packages.syncPriceTiers({})).toEqual({ created: [], retired: [], restored: [] });
    const senior = (await c.staff.list()).find((s) => s.name === "Senior")!;
    await c.staff.setServicePrices({}, senior.id, { [individual.id]: 500000 });
    const { created: added, retired } = await c.packages.syncPriceTiers({});
    // Nobody charges ₹7,000 for individual therapy any more: those three tiers go off sale.
    expect(retired.map((p) => [p.sessions, p.creditValuePaise, p.active]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [4, 700000, false],
      [8, 700000, false],
      [12, 700000, false],
    ]);
    expect(added.map((p) => [p.sessions, p.creditValuePaise, p.pricePaise]).sort((a, b) => a[0] - b[0])).toEqual([
      [4, 500000, 1800000],
      [8, 500000, 3400000],
      [12, 500000, 4800000],
    ]);
  });

  it("put a tier back on sale when its price returns, and keep a hand-edited tier price", async () => {
    const { individual } = await setup();
    const { created } = await c.packages.syncPriceTiers({});
    const four = created.find((p) => p.serviceIds[0] === individual.id && p.sessions === 4)!;
    await c.packages.update({}, four.id, { ...four, pricePaise: 2400000 });
    const senior = (await c.staff.list()).find((s) => s.name === "Senior")!;
    await c.staff.setServicePrices({}, senior.id, { [individual.id]: 500000 });
    await c.packages.syncPriceTiers({});
    await c.staff.setServicePrices({}, senior.id, { [individual.id]: 700000 });
    const { restored, created: again } = await c.packages.syncPriceTiers({});
    expect(again).toEqual([]);
    expect(restored.find((p) => p.id === four.id)).toMatchObject({ active: true, pricePaise: 2400000 });
  });

  it("never touch packages the firm made by hand", async () => {
    await setup();
    await c.packages.syncPriceTiers({});
    const own = (await c.packages.list()).filter((p) => !/tier$/.test(p.name));
    expect(own).toHaveLength(5);
    expect(own.every((p) => p.active)).toBe(true);
  });

  it("take a therapist's tiers off sale when they are deactivated", async () => {
    await setup();
    await c.packages.syncPriceTiers({});
    const senior = (await c.staff.list()).find((s) => s.name === "Senior")!;
    await c.staff.update({}, senior.id, { active: false });
    const { retired } = await c.packages.syncPriceTiers({});
    expect(retired).toHaveLength(5);
    expect(retired.every((p) => !p.active && p.retiredAutomatically)).toBe(true);
  });

  it("leave a tier the firm took off sale off sale", async () => {
    await setup();
    const { created } = await c.packages.syncPriceTiers({});
    const tier = created[0];
    await c.packages.update({}, tier.id, { ...tier, active: false });
    const { restored, created: again } = await c.packages.syncPriceTiers({});
    expect(restored).toEqual([]);
    expect(again).toEqual([]);
    expect((await c.packages.get(tier.id)).active).toBe(false);
  });

  it("delete only packages nobody bought, and not a tier that would be made again", async () => {
    const { individual } = await setup();
    const { created } = await c.packages.syncPriceTiers({});
    const base = (await c.packages.list()).find((p) => p.name === "4 session package" && p.serviceIds[0] === individual.id)!;
    await c.packages.purchasePackage({}, base.id, { client: { name: "Ravi", phone: "98765 43210" }, amountPaise: 360000, razorpayPaymentId: "pay_tier1" });
    await expect(c.packages.remove({}, base.id)).rejects.toMatchObject({ code: "conflict" });
    const tier = created.find((p) => p.serviceIds[0] === individual.id && p.sessions === 4)!;
    await expect(c.packages.remove({}, tier.id)).rejects.toMatchObject({ code: "invalid" });
    // Once nobody charges that price, the unsold tier can go.
    const senior = (await c.staff.list()).find((s) => s.name === "Senior")!;
    await c.staff.setServicePrices({}, senior.id, { [individual.id]: 500000 });
    await c.packages.syncPriceTiers({});
    await c.packages.remove({}, tier.id);
    await expect(c.packages.get(tier.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
