import { notFound } from "next/navigation";
import { app } from "@/features/container";
import { isDomainError } from "@/features/shared/errors";
import { requireStaff } from "@/lib/session";
import { Notice } from "@/components/Notice";
import { PageHeader } from "@/components/Shell";
import { ServiceFields } from "@/components/ServiceFields";
import { deleteServiceAction, updateServiceAction } from "../../actions";

export default async function ServiceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await requireStaff("manager");
  const { id } = await params;
  const { error, ok } = await searchParams;
  const s = await app().catalog.get(id).catch((err) => {
    if (isDomainError(err)) notFound();
    throw err;
  });
  return (
    <>
      <PageHeader title={s.name} subtitle={`${s.durationMin} minutes${s.priceDisplay ? ` · ${s.priceDisplay}` : ""}`} />
      <Notice error={error} ok={ok} />
      <form action={updateServiceAction.bind(null, id)} className="card grid max-w-2xl gap-4 p-6 sm:grid-cols-2">
        <ServiceFields s={s} />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="toggle" name="active" defaultChecked={s.active} /> Bookable
        </label>
        <div className="sm:col-span-2"><button className="btn" type="submit">Save</button></div>
      </form>
      <form action={deleteServiceAction.bind(null, id)} className="card mt-4 max-w-2xl p-6">
        <h2 className="mb-1 font-semibold">Delete service</h2>
        <p className="mb-4 text-sm text-zinc-600">Only for a service nobody has booked and no package or workflow uses. Otherwise untick Bookable above to hide it.</p>
        <button className="btn-ghost text-red-700" type="submit">Delete service</button>
      </form>
    </>
  );
}
