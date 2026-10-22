"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { app } from "@/features/container";
import { DomainError, isDomainError } from "@/features/shared/errors";
import { DESIGNATIONS } from "@/features/staff/staff.dto";
import { act, optional, optionalNumber, str } from "@/lib/form-actions";
import { parseQuestions } from "@/features/catalog/questions";
import { parseDayRanges } from "@/lib/hours-form";
import { zonedToUtc } from "@/lib/time";
import { requireStaff, hasRole } from "@/lib/session";

/** Staff may edit their own hours and time off; managers and admins may edit anyone's. */
async function requireSelfOrManager(staffId: string) {
  const me = await requireStaff();
  if (me.id !== staffId && !hasRole(me, "manager")) redirect("/?error=forbidden");
  return me;
}

/** The chosen designation, or null when none (or something that is not on the list) was sent. */
const designationOf = (form: FormData) => DESIGNATIONS.find((d) => d === str(form, "designation")) ?? null;

export async function createStaffAction(form: FormData) {
  const me = await requireStaff("manager");
  const role = str(form, "role") as "admin" | "manager" | "staff";
  await act("/admin/staff", "Staff member added", async () => {
    if (role === "admin" && !hasRole(me, "admin")) throw new DomainError("forbidden", "Only admins can add admins");
    await app().staff.create({ staffId: me.id }, {
      name: str(form, "name"),
      email: str(form, "email"),
      role,
      designation: designationOf(form),
      timezone: str(form, "timezone") || "Asia/Kolkata",
    });
  });
}

export async function updateStaffAction(staffId: string, form: FormData) {
  const me = await requireStaff("manager");
  const path = `/admin/staff/${staffId}`;
  await act(path, "Saved", async () => {
    const target = await app().staff.get(staffId);
    const role = str(form, "role") as "admin" | "manager" | "staff";
    const changesAdmin = role !== target.role && (role === "admin" || target.role === "admin");
    if (changesAdmin && !hasRole(me, "admin")) throw new DomainError("forbidden", "Only admins can change admin roles");
    if (staffId === me.id && (role !== me.role || form.get("active") !== "on")) {
      throw new DomainError("invalid", "You can't change your own role or deactivate yourself");
    }
    await app().staff.update({ staffId: me.id }, staffId, {
      name: str(form, "name"),
      email: str(form, "email"),
      role,
      designation: designationOf(form),
      timezone: str(form, "timezone"),
      active: form.get("active") === "on",
      // Only admins see the switch, so a manager saving the form leaves it as it is.
      clinicalAdmin: hasRole(me, "admin") ? form.get("clinicalAdmin") === "on" : undefined,
    });
    const offered = form.getAll("serviceIds").map(String);
    await app().staff.setServices({ staffId: me.id }, staffId, offered);
    // Typed in rupees; blank means "use the service's price".
    const prices = Object.fromEntries(
      offered.map((id) => {
        const raw = str(form, `price_${id}`).replace(/,/g, "");
        return [id, raw === "" ? null : Math.round(Number(raw) * 100)] as const;
      }),
    );
    if (Object.values(prices).some((p) => p !== null && Number.isNaN(p))) throw new DomainError("invalid", "Enter prices as plain numbers, e.g. 2500");
    await app().staff.setServicePrices({ staffId: me.id }, staffId, prices);
    // Packages follow the prices: a new price gets its own packages straight away.
    await app().packages.syncPriceTiers({ staffId: me.id });
  });
}

export async function setHoursAction(staffId: string, form: FormData) {
  const me = await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Working hours saved", async () => {
    const ranges = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => parseDayRanges(d, str(form, `day${d}`)));
    await app().schedules.setWeeklyHours({ staffId: me.id }, staffId, ranges);
  });
}

export async function addTimeOffAction(staffId: string, form: FormData) {
  const me = await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Time off added", async () => {
    const target = await app().staff.get(staffId);
    // The form sends local wall-clock times; interpret them in the staff member's time zone.
    await app().schedules.addTimeOff({ staffId: me.id }, staffId, {
      startsAt: zonedToUtc(str(form, "startsAt"), target.timezone),
      endsAt: zonedToUtc(str(form, "endsAt"), target.timezone),
      reason: optional(form, "reason"),
    });
  });
}

export async function removeTimeOffAction(staffId: string, timeOffId: string) {
  const me = await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Time off removed", () =>
    app().schedules.removeTimeOff({ staffId: me.id }, staffId, timeOffId),
  );
}

function serviceFields(form: FormData) {
  return {
    name: str(form, "name"),
    description: optional(form, "description"),
    durationMin: Number(str(form, "durationMin")),
    bufferBeforeMin: Number(str(form, "bufferBeforeMin") || 0),
    bufferAfterMin: Number(str(form, "bufferAfterMin") || 0),
    priceDisplay: optional(form, "priceDisplay"),
    slotIntervalMin: optionalNumber(form, "slotIntervalMin"),
    minNoticeMin: optionalNumber(form, "minNoticeMin"),
    maxNoticeDays: optionalNumber(form, "maxNoticeDays"),
    maxPerDay: optionalNumber(form, "maxPerDay"),
    location: optional(form, "location"),
    meetingType: str(form, "meetingType") === "google_meet" ? ("google_meet" as const) : ("in_person" as const),
    questions: parseQuestions(str(form, "questions")),
  };
}

export async function createServiceAction(form: FormData) {
  const me = await requireStaff("manager");
  await act("/admin/services", "Service added", () => app().catalog.create({ staffId: me.id }, serviceFields(form)));
}

export async function updateServiceAction(serviceId: string, form: FormData) {
  const me = await requireStaff("manager");
  await act(`/admin/services/${serviceId}`, "Saved", async () => {
    await app().catalog.update({ staffId: me.id }, serviceId, { ...serviceFields(form), active: form.get("active") === "on" });
    // A new base price changes what therapists without their own price charge, so their packages follow.
    await app().packages.syncPriceTiers({ staffId: me.id });
  });
}

export async function deleteServiceAction(serviceId: string) {
  const me = await requireStaff("manager");
  await act(`/admin/services/${serviceId}`, "Service deleted", async () => {
    await app().catalog.remove({ staffId: me.id }, serviceId);
    return "/admin/services";
  });
}

export async function setDateOverrideAction(staffId: string, form: FormData) {
  const me = await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Date-specific hours saved", async () => {
    const off = form.get("off") === "on";
    const ranges = off
      ? []
      : [1, 2]
          .map((n) => ({ startTime: str(form, `start${n}`), endTime: str(form, `end${n}`) }))
          .filter((r) => r.startTime || r.endTime);
    if (!off && !ranges.length) throw new DomainError("invalid", "Add hours for that date, or switch on \"Unavailable all day\"");
    await app().schedules.setDateOverride({ staffId: me.id }, staffId, { date: str(form, "date"), ranges });
  });
}

export async function removeDateOverrideAction(staffId: string, date: string) {
  const me = await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Date-specific hours removed", () =>
    app().schedules.removeDateOverride({ staffId: me.id }, staffId, date),
  );
}

export async function sendTestEmailAction(form: FormData) {
  await requireStaff("admin");
  const to = str(form, "to");
  await act("/admin/settings", `Test email sent to ${to}. Check that inbox (and spam).`, () => app().mail.sendTest(to));
}

export async function sendSampleEmailAction(form: FormData) {
  await requireStaff("admin");
  const to = str(form, "to");
  await act("/admin/settings", `Sample email sent to ${to}. Open it to check the design.`, () => app().mail.sendSample(to));
}

export async function updateSettingsAction(form: FormData) {
  const me = await requireStaff("admin");
  await act("/admin/settings", "Settings saved", () =>
    app().settings.update({ staffId: me.id }, {
      name: str(form, "name"),
      timezone: str(form, "timezone"),
      currency: str(form, "currency"),
      bookingPrefix: str(form, "bookingPrefix"),
      slotIntervalMin: str(form, "slotIntervalMin"),
      minNoticeMin: str(form, "minNoticeMin"),
      maxNoticeDays: str(form, "maxNoticeDays"),
      clientCutoffMin: Number(str(form, "clientCutoffHours")) * 60,
      logoUrl: str(form, "logoUrl"),
      brandColor: str(form, "brandColor") || "#000000",
      welcomeText: str(form, "welcomeText"),
      resumeUrl: str(form, "resumeUrl"),
      onlinePayment: form.get("onlinePayment") === "on",
      meetEnabled: form.get("meetEnabled") === "on",
      emailBranded: form.get("emailBranded") === "on",
    }),
  );
}

const PROFILE_FIELDS = [
  "dateOfBirth", "gender", "maritalStatus", "occupation", "education", "location", "languages",
  "emergencyName", "emergencyRelation", "emergencyPhone", "referralSource", "consentSignedAt",
] as const;

export async function updateClientProfileAction(clientId: string, form: FormData) {
  const me = await requireStaff("manager");
  const profile = Object.fromEntries(PROFILE_FIELDS.map((k) => [k, str(form, k)]));
  // Saved: back to the client. Failed: stay on the form so nothing typed is lost from view.
  await act(`/admin/clients/${clientId}/edit`, "Client saved", async () => {
    await app().clients.updateProfile({ staffId: me.id }, clientId, {
      name: str(form, "name"),
      email: optional(form, "email"),
      whatsappOptIn: form.get("whatsappOptIn") === "on",
      notes: optional(form, "notes"),
      ...profile,
    });
    return `/admin/clients/${clientId}`;
  });
}

export async function createClientAction(form: FormData) {
  const me = await requireStaff("manager");
  await act("/admin/clients/new", "Client added", async () => {
    const created = await app().clients.create({ staffId: me.id }, {
      name: str(form, "name"),
      phone: str(form, "phone"),
      email: optional(form, "email"),
      whatsappOptIn: form.get("whatsappOptIn") === "on",
      notes: optional(form, "notes"),
    });
    if (str(form, "staffId")) await app().clients.assignTherapist({ staffId: me.id }, created.id, { staffId: str(form, "staffId") });
    return `/admin/clients/${created.id}`;
  });
}

export async function assignTherapistAction(clientId: string, form: FormData) {
  const me = await requireStaff("manager");
  await act(`/admin/clients/${clientId}`, "Therapist assigned", () =>
    app().clients.assignTherapist({ staffId: me.id }, clientId, { staffId: str(form, "staffId"), reason: str(form, "reason") }),
  );
}

export type NewApiKeyState ={ key?: string; name?: string; error?: string } | null;

/** Returns the raw key to the form instead of redirecting, so it never lands in a URL or the server logs. */
export async function createApiKeyAction(_prev: NewApiKeyState, form: FormData): Promise<NewApiKeyState> {
  await requireStaff("admin");
  try {
    // Only these two can be issued from the screen; "staff" keys stay a command-line job.
    const scope = str(form, "scope") === "otp" ? "otp" : "website";
    const { key, record } = await app().apiKeys.create({ name: str(form, "name"), scopes: [scope] });
    revalidatePath("/admin/settings/api");
    revalidatePath("/admin/otp");
    return { key, name: record.name };
  } catch (err) {
    if (isDomainError(err)) return { error: err.message };
    throw err;
  }
}

export async function revokeApiKeyAction(id: string) {
  await requireStaff("admin");
  await app().apiKeys.revoke(id);
  redirect("/admin/settings/api?ok=" + encodeURIComponent("API key revoked. Sites using it stop working now"));
}

export async function addHolidayAction(form: FormData) {
  const me = await requireStaff("admin");
  await act("/admin/settings/holidays", "Holiday added", () => app().holidays.add({ staffId: me.id }, { date: str(form, "date"), name: str(form, "name") }));
}

export async function removeHolidayAction(id: string) {
  const me = await requireStaff("admin");
  await act("/admin/settings/holidays", "Holiday removed", () => app().holidays.remove({ staffId: me.id }, id));
}

export async function disconnectCalendarAction(staffId: string) {
  await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Google Calendar disconnected", () => app().calendar.disconnect(staffId));
}

export async function calendarOptionsAction(staffId: string, form: FormData) {
  await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Calendar settings saved", () =>
    app().calendar.setOptions(staffId, { pushBookings: form.get("pushBookings") === "on", blockBusy: form.get("blockBusy") === "on", inviteClients: form.get("inviteClients") === "on", createMeetLinks: form.get("createMeetLinks") === "on" }),
  );
}

export async function syncCalendarAction(staffId: string) {
  await requireSelfOrManager(staffId);
  await act(`/admin/staff/${staffId}`, "Calendar synced", () => app().calendar.syncNow(staffId));
}
