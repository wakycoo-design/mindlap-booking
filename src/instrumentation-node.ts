/**
 * Fails unpaid bookings after 15 minutes, cancels them after 24 hours, sends due workflow messages, writes bookings to staff calendars and copies their busy times, all from
 * inside the app so reminders and follow-ups need no extra service.
 * With several containers they all run it; `claimDue` hands each message to only one of them.
 * Kept out of instrumentation.ts so the Edge build never tries to load Node-only code.
 */
export function startWorkflowWorker() {
  // A serverless host (Vercel) freezes the app between requests, so a timer can't be relied on: it calls /api/internal/jobs/run instead.
  if (process.env.WORKFLOW_RUNNER === "off" || process.env.VERCEL) return;
  const g = globalThis as unknown as { workflowTimer?: NodeJS.Timeout };
  if (g.workflowTimer) return; // dev reloads call register() again
  let running = false;
  // Every run touches Postgres, so a longer gap lets a scale-to-zero database (Neon) sleep between runs. Reminders then arrive up to this many seconds late.
  const everySec = Math.max(10, Number(process.env.WORKFLOW_INTERVAL_SEC) || 30);
  g.workflowTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { app } = await import("@/features/container");
      const { workflows, payments, calendar } = app();
      // Payments first, so a booking that just failed gets its "complete your payment" message this round.
      await payments.expire();
      await workflows.processDue();
      await calendar.processDue();
      await calendar.syncBusy();
    } catch (err) {
      console.error("Workflow worker failed", err);
    } finally {
      running = false;
    }
  }, everySec * 1000);
  g.workflowTimer.unref();
}
