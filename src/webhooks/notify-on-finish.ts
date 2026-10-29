import type { Diagnostics } from "../core/diagnostics";
import type { Job } from "../core/job";
import { postJobWebhookEvent } from "./dispatch";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one thing `notifyOnFinish` needs from `ArtifactTickets` — small on purpose, so a test can fake it without a real ticket store. */
export interface TicketIssuer {
  issue(jobId: string): string;
}

/**
 * Wires `JobScheduler`'s `onFinished` hook (core, never aware of webhooks) to the primitives already
 * ported in STA-32: a job queued with a `webhookUrl` gets a signed "finished" event the moment it
 * reaches a terminal status, with `links.report` carrying a ticket when the job has a report —
 * exactly what STA-35's acceptance criteria ask for ("notifica con enlaces a log y reporte").
 *
 * `job.reportPath ? artifactTickets.issue(job.id) : undefined` runs for every finished job
 * regardless of `webhookUrl` (not just inside the `if` below): this is also what pre-warms the
 * ticket STA-54's web "Ver reporte" flow relies on, so a webhook-less job still gets one.
 *
 * Returns an async function (not `void`-returning) purely so a test can `await` it deterministically
 * instead of guessing a `setTimeout`; `JobScheduler.onFinished` is typed `(job: Job) => void` and never
 * awaits what it calls (fire-and-forget on purpose). `postJobWebhookEvent` catches every failure of
 * its own already, but everything here still runs inside its own try/catch regardless (found by
 * review): nothing calling this ever awaits or attaches a `.catch` to it, so *any* rejection — a future
 * change to `artifactTickets.issue` or to `buildWebhookPayload` that starts throwing, not just a
 * network failure — would otherwise be an unhandled rejection, which kills the whole process by
 * default in Node, not just this one job's notification.
 */
export function notifyOnFinish(artifactTickets: TicketIssuer, baseUrl: string, diagnostics: Diagnostics): (job: Job) => Promise<void> {
  return async (job) => {
    try {
      const reportTicket = job.reportPath ? artifactTickets.issue(job.id) : undefined;
      if (!job.webhookUrl) return;
      await postJobWebhookEvent(job.webhookUrl, { event: "finished", job, phase: null, phaseIndex: null, baseUrl, reportTicket }, diagnostics);
    } catch (error) {
      diagnostics.error({ job: job.id, error: describeError(error) }, "onFinished notification failed unexpectedly");
    }
  };
}
