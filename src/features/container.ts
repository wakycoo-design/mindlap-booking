import { getDb, type Db } from "@/db";
import { defer } from "@/lib/after";
import { createApiKeysRepository } from "./api-keys/api-keys.repository";
import { createApiKeysService } from "./api-keys/api-keys.service";
import { createAvailabilityRepository } from "./availability/availability.repository";
import { createAvailabilityService } from "./availability/availability.service";
import type { BookingEvent } from "./bookings/bookings.dto";
import { manageToken } from "./bookings/manage-link";
import { createBookingsRepository } from "./bookings/bookings.repository";
import { createBookingsService } from "./bookings/bookings.service";
import { hasPrice } from "./catalog/catalog.dto";
import { DomainError } from "./shared/errors";
import { createCatalogRepository } from "./catalog/catalog.repository";
import { createCatalogService } from "./catalog/catalog.service";
import { createCalendarRepository } from "./calendar/calendar.repository";
import { createCalendarService } from "./calendar/calendar.service";
import { createGoogleProvider } from "./calendar/google";
import type { CalendarProvider } from "./calendar/provider";
import { createClientsRepository } from "./clients/clients.repository";
import { createClientsService } from "./clients/clients.service";
import { createHolidaysRepository } from "./holidays/holidays.repository";
import { createHolidaysService } from "./holidays/holidays.service";
import { createHealthRepository } from "./health/health.repository";
import type { OtpSender } from "./otp/otp.dto";
import { createOtpRepository } from "./otp/otp.repository";
import { createOtpSender } from "./otp/otp.sender";
import { createOtpService } from "./otp/otp.service";
import { createPackagesRepository } from "./packages/packages.repository";
import { createPackagesService } from "./packages/packages.service";
import { createPaymentsRepository } from "./payments/payments.repository";
import { createPaymentsService } from "./payments/payments.service";
import { createPreferencesRepository } from "./preferences/preferences.repository";
import { createPreferencesService } from "./preferences/preferences.service";
import { createPerformanceRepository } from "./performance/performance.repository";
import { createPerformanceService } from "./performance/performance.service";
import type { AttendanceSource } from "./performance/performance.dto";
import { createReportsRepository } from "./reports/reports.repository";
import { createReportsService } from "./reports/reports.service";
import { createSchedulesRepository } from "./schedules/schedules.repository";
import { createSchedulesService } from "./schedules/schedules.service";
import { createSettingsRepository } from "./settings/settings.repository";
import { createSettingsService } from "./settings/settings.service";
import { createStaffRepository } from "./staff/staff.repository";
import { passwordResetEmail } from "./staff/password-reset-email";
import { createStaffService } from "./staff/staff.service";
import { mailStatus, sendSampleEmail, sendTestEmail } from "./workflows/mail";
import { PRESETS } from "./workflows/presets";
import { createSenders } from "./workflows/senders";
import { createWorkflowsRepository } from "./workflows/workflows.repository";
import { createWorkflowsService, type Senders } from "./workflows/workflows.service";
import { createCaseHistoryRepository } from "./case-history/case-history.repository";
import { createCaseHistoryService } from "./case-history/case-history.service";

/**
 * Wires repositories into services. This is the only place that picks the storage
 * implementation, so swapping Postgres for another store means new repositories here.
 */
export function createContainer(db: Db, opts: {
    senders?: Senders;
    otpSender?: OtpSender;
    manageSecret?: string;
    appUrl?: string;
    calendarProvider?: CalendarProvider;
    /** Where therapist join times come from (Google Meet once connected). Without one the punctuality KPI reports "no data". */
    attendance?: AttendanceSource;
    /** Runs follow-up work after the current request has answered. Without it, queued work waits for the scheduler. */
    defer?: (task: () => Promise<unknown>) => void;
  } = {}) {
  const appUrl = (opts.appUrl ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const manageSecret = opts.manageSecret ?? process.env.AUTH_SECRET;
  const staffRepo = createStaffRepository(db);
  const catalogRepo = createCatalogRepository(db);
  const settingsRepo = createSettingsRepository(db);
  const bookingsRepo = createBookingsRepository(db);
  const availability = createAvailabilityService({
    availabilityRepo: createAvailabilityRepository(db),
    catalogRepo,
    staffRepo,
    settingsRepo,
  });
  const senders = opts.senders ?? createSenders();
  const workflows = createWorkflowsService({
    // The client's page for moving or cancelling a booking, for use in messages.
    manageToken: (id) => (manageSecret ? manageToken(id, manageSecret) : null),
    calendarFileUrl: (id) => `${appUrl}/manage/${id}/calendar.ics`,
    defaultLogoUrl: `${appUrl}/brand/waky-logo.png`,
    joinLink: (id) => (manageSecret ? `${appUrl}/join/${id}?t=${manageToken(id, manageSecret)}` : null),
    manageLink: (id) => (manageSecret ? `${appUrl}/manage/${id}?t=${manageToken(id, manageSecret)}` : null),
    workflowsRepo: createWorkflowsRepository(db),
    catalogRepo,
    settingsRepo,
    senders,
  });
  const calendar = createCalendarService({
    calendarRepo: createCalendarRepository(db),
    provider: opts.calendarProvider ?? createGoogleProvider(),
    appUrl,
    secret: process.env.CALENDAR_ENCRYPTION_KEY || manageSecret,
  });
  // Everything that reacts to a booking change. Each listener runs even if another fails.
  const onEvent = async (event: BookingEvent) => {
    const results = await Promise.allSettled([workflows.onBookingEvent(event), calendar.onBookingEvent(event)]);
    for (const r of results) if (r.status === "rejected") console.error(`Listener for booking event ${event.type} failed`, r.reason);
    // Send what was just queued (the calendar event with its Meet link, the confirmation message) straight away instead of
    // waiting for the next scheduled run. The scheduler still covers reminders, timeouts and retries.
    opts.defer?.(async () => {
      await calendar.processDue();
      await workflows.processDue();
    });
  };
  return {
    staff: createStaffService({
      staffRepo,
      async sendResetLink(to, token) {
        const firm = await settingsRepo.get();
        const link = `${appUrl}/reset-password?token=${token}`;
        const mail = passwordResetEmail({ name: to.name, link, firmName: firm.name, logoUrl: firm.logoUrl ?? `${appUrl}/brand/waky-logo.png` });
        await senders.email({ channel: "email", to: to.email, subject: mail.subject, body: mail.text, html: mail.html });
      },
    }),
    catalog: createCatalogService({ catalogRepo }),
    schedules: createSchedulesService({ schedulesRepo: createSchedulesRepository(db) }),
    settings: createSettingsService({ settingsRepo }),
    clients: createClientsService({ clientsRepo: createClientsRepository(db) }),
    caseHistory: createCaseHistoryService({
      caseRepo: createCaseHistoryRepository(db),
      senders: { email: senders.email, whatsapp: senders.whatsapp },
      firmName: async () => (await settingsRepo.get()).name,
    }),
    availability,
    bookings: createBookingsService({
      bookingsRepo,
      availability,
      settingsRepo,
      onEvent,
      manageSecret,
    }),
    workflows,
    /** The one mailbox every notification is sent from: whether it is set up, and a test message. */
    mail: {
      status: () => mailStatus(),
      sendTest: async (to: string) => sendTestEmail(senders.email, to, (await settingsRepo.get()).name),
      /** The confirmation message as it will look, with made-up details. Uses the firm's own confirmation text when there is one. */
      async sendSample(to: string) {
        const firm = await settingsRepo.get();
        const own = (await workflows.list()).find((w) => w.channel === "email" && w.trigger === "booked" && w.active);
        const template = own && "body" in own.config ? own.config.body : (PRESETS[0].input.action as { body: string }).body;
        return sendSampleEmail(senders.email, to, { name: firm.name, logoUrl: firm.logoUrl ?? `${appUrl}/brand/waky-logo.png` }, template);
      },
    },
    calendar,
    preferences: createPreferencesService({ preferencesRepo: createPreferencesRepository(db) }),
    packages: createPackagesService({
      packagesRepo: createPackagesRepository(db),
      async priceFor(serviceId, staffId) {
        const svc = await catalogRepo.findById(serviceId);
        if (!svc) throw new DomainError("not_found", `Service ${serviceId} not found`);
        const own = staffId ? await bookingsRepo.staffPrice(staffId, serviceId) : null;
        return { serviceName: svc.name, owes: own !== null ? own > 0 : hasPrice(svc), pricePaise: own ?? svc.pricePaise };
      },
      async pricesFor(serviceIds) {
        const ids = serviceIds.length ? serviceIds : (await catalogRepo.list()).filter((s) => s.active).map((s) => s.id);
        const people = (await Promise.all(ids.map((id) => staffRepo.listBookableForService(id)))).flat();
        return [...new Set(people.map((p) => p.pricePaise).filter((p): p is number => p !== null))].sort((a, b) => a - b);
      },
    }),
    payments: createPaymentsService({
      paymentsRepo: createPaymentsRepository(db),
      bookingsRepo,
      availability,
      onEvent,
    }),
    reports: createReportsService({ reportsRepo: createReportsRepository(db), settingsRepo }),
    performance: createPerformanceService({ performanceRepo: createPerformanceRepository(db), attendance: opts.attendance }),
    holidays: createHolidaysService({ holidaysRepo: createHolidaysRepository(db) }),
    apiKeys: createApiKeysService({ apiKeysRepo: createApiKeysRepository(db) }),
    otp: createOtpService({ otpRepo: createOtpRepository(db), send: opts.otpSender ?? createOtpSender(), secret: manageSecret }),
    health: createHealthRepository(db),
  };
}

export type Container = ReturnType<typeof createContainer>;

const globalForContainer = globalThis as unknown as { container?: Container };

export function app(): Container {
  // Tests wait for nothing in the background, so follow-up work is only deferred outside them.
  globalForContainer.container ??= createContainer(getDb(), { defer: process.env.NODE_ENV === "test" ? undefined : defer });
  return globalForContainer.container;
}
