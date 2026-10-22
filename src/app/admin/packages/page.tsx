import { app } from "@/features/container";
import { requireStaff } from "@/lib/session";
import { Notice } from "@/components/Notice";
import { PageHeader } from "@/components/Shell";
import { createPackageAction, deletePackageAction, syncPriceTiersAction, updatePackageAction } from "./actions";

export const dynamic = "force-dynamic";

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type Services = Awaited<ReturnType<ReturnType<typeof app>["catalog"]["list"]>>;
type Pkg = Awaited<ReturnType<ReturnType<typeof app>["packages"]["list"]>>[number];

function Fields({ services, p }: { services: Services; p?: Pkg }) {
  return (
    <>
      <div className="sm:col-span-2"><label className="label">Name</label><input className="input" name="name" defaultValue={p?.name} placeholder="e.g. 4 counselling sessions" required /></div>
      <div><label className="label">Credits</label><input className="input" name="sessions" type="number" min={1} max={500} defaultValue={p?.sessions ?? 4} required /></div>
      <div><label className="label">Price for the package (₹)</label><input className="input" name="price" inputMode="decimal" defaultValue={p ? String(p.pricePaise / 100) : ""} placeholder="3600" required /></div>
      <div>
        <label className="label">One credit covers (₹)</label>
        <input className="input" name="creditValue" inputMode="decimal" defaultValue={p ? String(p.creditValuePaise / 100) : "1000"} required />
        <p className="mt-1 text-xs text-zinc-600">A ₹1,500 service uses 1.5 credits when this is ₹1,000.</p>
      </div>
      <div>
        <label className="label">Valid for (days)</label>
        <input className="input" name="validityDays" type="number" min={1} max={3650} defaultValue={p ? p.validityDays ?? "" : 365} placeholder="Never expires" />
      </div>
      <label className="flex items-center gap-3 self-end pb-2 text-sm"><input type="checkbox" className="toggle" name="active" defaultChecked={p?.active ?? true} /> On sale</label>
      <fieldset className="sm:col-span-2">
        <legend className="label">Can be used for</legend>
        <p className="mb-2 text-xs text-zinc-600">Tick the services it pays for. Leave all unticked for any service.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {services.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="serviceIds" value={s.id} defaultChecked={p?.serviceIds.includes(s.id)} /> {s.name}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}

export default async function PackagesPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireStaff("manager");
  const { error, ok } = await searchParams;
  const [packages, services] = await Promise.all([app().packages.list(), app().catalog.list()]);
  const nameOf = new Map(services.map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader title="Packages" subtitle="Credits sold in advance. A booking uses credits in proportion to its price; cancelling gives them back." />
      <Notice error={error} ok={ok} />
      <div className="mb-10 grid gap-3">
        {packages.length === 0 && <p className="card p-6 text-sm text-zinc-600">No packages yet. Add your first one below.</p>}
        {packages.map((p) => (
          <details key={p.id} className="card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-1 p-4">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{p.name}</span>
                <span className="block truncate text-sm text-zinc-600">{p.serviceIds.length ? p.serviceIds.map((id) => nameOf.get(id) ?? "?").join(", ") : "Any service"}</span>
              </span>
              <span className="badge">{p.sessions} credits</span>
              <span className="w-28 text-right text-sm">{rupees(p.pricePaise)}<span className="block text-xs text-zinc-600">{rupees(Math.round(p.pricePaise / p.sessions))} per credit</span></span>
              <span className="text-xs text-zinc-600">{p.validityDays ? `${p.validityDays} days` : "No expiry"}</span>
              {!p.active && <span className="badge text-zinc-600">Off sale</span>}
              <span className="text-sm text-zinc-600 underline">Edit</span>
            </summary>
            <form action={updatePackageAction.bind(null, p.id)} className="grid gap-4 border-t border-zinc-100 p-4 sm:grid-cols-2">
              <Fields services={services} p={p} />
              <p className="text-xs text-zinc-600 sm:col-span-2">Changes affect new sales only. Clients who already bought it keep what they bought.</p>
              <div className="sm:col-span-2"><button className="btn" type="submit">Save</button></div>
            </form>
            <form action={deletePackageAction.bind(null, p.id)} className="border-t border-zinc-100 px-4 py-3">
              <button className="btn-ghost text-red-700" type="submit">Delete package</button>
              <span className="ml-3 text-xs text-zinc-600">Only if nobody bought it. Otherwise untick &ldquo;On sale&rdquo; above.</span>
            </form>
          </details>
        ))}
      </div>
      <section className="card mb-6 max-w-2xl p-6">
        <h2 className="mb-2 font-semibold">Packages for every therapist price</h2>
        <p className="mb-4 text-sm text-zinc-600">
          Each package you add is repeated at every price your therapists charge, with the same discount (marked
          &ldquo;· ₹… tier&rdquo;). This happens by itself when you save a therapist or a service; tiers nobody charges any more
          go off sale. The website shows each client only the packages for the therapist they chose.
        </p>
        <form action={syncPriceTiersAction}><button className="btn-ghost" type="submit">Update price-tier packages now</button></form>
      </section>
      <section className="card max-w-2xl p-6">
        <h2 className="mb-5 font-semibold">Add a package</h2>
        <form action={createPackageAction} className="grid gap-4 sm:grid-cols-2">
          <Fields services={services} />
          <div className="sm:col-span-2"><button className="btn" type="submit">Add package</button></div>
        </form>
      </section>
    </>
  );
}
