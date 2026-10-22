"use server";

import { app } from "@/features/container";
import { act, optional, str } from "@/lib/form-actions";
import { requireStaff } from "@/lib/session";

/** Rupees typed in a form (commas allowed) as whole paise. */
const paise = (raw: string) => Math.round(Number(raw.replace(/,/g, "")) * 100);

function packageFromForm(form: FormData) {
  const validity = str(form, "validityDays");
  return {
    name: str(form, "name"),
    serviceIds: form.getAll("serviceIds").map(String),
    sessions: Number(str(form, "sessions")),
    pricePaise: paise(str(form, "price")),
    creditValuePaise: paise(str(form, "creditValue")),
    validityDays: validity === "" ? null : Number(validity),
    active: form.get("active") === "on",
  };
}

export async function createPackageAction(form: FormData) {
  const me = await requireStaff("manager");
  await act("/admin/packages", "Package added", () => app().packages.create({ staffId: me.id }, packageFromForm(form)));
}

export async function syncPriceTiersAction() {
  const me = await requireStaff("manager");
  await act("/admin/packages", "Price-tier packages are up to date", () => app().packages.syncPriceTiers({ staffId: me.id }));
}

export async function deletePackageAction(id: string) {
  const me = await requireStaff("manager");
  await act("/admin/packages", "Package deleted", () => app().packages.remove({ staffId: me.id }, id));
}

export async function updatePackageAction(id: string, form: FormData) {
  const me = await requireStaff("manager");
  await act("/admin/packages", "Package saved", () => app().packages.update({ staffId: me.id }, id, packageFromForm(form)));
}

export async function sellPackageAction(clientId: string, form: FormData) {
  const me = await requireStaff("manager");
  await act(`/admin/clients/${clientId}?tab=credits`, "Package sold", () =>
    app().packages.sell({ staffId: me.id }, clientId, { packageId: str(form, "packageId"), paymentNote: optional(form, "paymentNote") }),
  );
}

export async function topUpWalletAction(clientId: string, form: FormData) {
  const me = await requireStaff("manager");
  await act(`/admin/clients/${clientId}?tab=credits`, "Wallet money added", () =>
    app().packages.topUp({ staffId: me.id }, clientId, { amountPaise: paise(str(form, "amount")), note: optional(form, "note") }),
  );
}
