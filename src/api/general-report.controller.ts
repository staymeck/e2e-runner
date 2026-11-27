import { Controller, Get, Inject, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { GeneralReportAccessGuard } from "./general-report-access.guard";
import { Public, Roles } from "../auth/access-control";
import { ARTIFACT_TICKETS, GENERAL_REPORT_TICKET_SUBJECT, type TicketStore } from "../auth/artifact-ticket";
import { PUBLIC_BASE_URL } from "../config/public-base-url";
import { GENERAL_REPORT_STORE, REPORT_BRANCH, type GeneralReportEntry, type GeneralReportStore } from "../core/general-report-store";
import { JOB_SERVICE, type JobService } from "../core/job-service";
import type { Outcome } from "../core/job";

export interface GeneralReportEntryView {
  readonly target: string;
  readonly latestOutcome: Outcome;
  readonly latestJobId: string;
  readonly latestFinishedAt: string;
}

export interface GeneralReportView {
  readonly project: string;
  readonly branch: string;
  readonly scenarios: readonly GeneralReportEntryView[];
}

function toView(entry: GeneralReportEntry): GeneralReportEntryView {
  return { target: entry.target, latestOutcome: entry.latestOutcome, latestJobId: entry.latestJobId, latestFinishedAt: entry.latestFinishedAt };
}

const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = { success: "OK", warning: "Advertencia", failure: "Falló" };
const OUTCOME_COLOR: Readonly<Record<Outcome, string>> = { success: "#1a7f37", warning: "#9a6700", failure: "#cf222e" };

function renderHtml(view: GeneralReportView, jobTicketOf: (jobId: string) => string): string {
  const rows = view.scenarios
    .map((entry) => {
      const color = OUTCOME_COLOR[entry.latestOutcome];
      const label = OUTCOME_LABEL[entry.latestOutcome];
      // Relative, not absolute: this page is served at .../v1/report/general/html, possibly behind a
      // path-prefixing proxy (E2E_SERVICE_PUBLIC_URL) — a relative link honors that prefix, an
      // absolute /v1/... one would silently drop it. Two levels up from .../report/general/ reaches
      // .../v1/, where jobs/:id/report actually lives. GET .../jobs/:id/log has no ticket support
      // (payload.ts's own doc: it needs a normal Bearer, by design) — never link it from here, it
      // would just 401 for the anonymous viewer this page exists for.
      const reportUrl = `../../jobs/${entry.latestJobId}/report?ticket=${encodeURIComponent(jobTicketOf(entry.latestJobId))}`;
      return `<tr>
        <td>${entry.target}</td>
        <td style="color:${color};font-weight:600">${label}</td>
        <td>${entry.latestFinishedAt}</td>
        <td><a href="${reportUrl}">Ver reporte</a></td>
      </tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Reporte general — ${view.branch}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:.5rem;text-align:left}</style>
</head>
<body>
<h1>Reporte general — ${view.project} @ ${view.branch}</h1>
<table><thead><tr><th>Escenario</th><th>Estado</th><th>Última corrida</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="4">Todavía no hay corridas en esta rama.</td></tr>`}</tbody></table>
</body></html>`;
}

/**
 * The aggregate, always-current status of every scenario on the branch `E2E_SERVICE_REPORT_BRANCH`
 * tracks — the "general report" the web's Status page and the webhook's default `links.report` both
 * point at. Separate from `JobsController`: this is a new concept, not a sub-resource of a job or a
 * project (STA — general report).
 */
@Roles("e2e-mobile")
@Controller("v1/report")
export class GeneralReportController {
  constructor(
    @Inject(GENERAL_REPORT_STORE) private readonly store: GeneralReportStore,
    @Inject(REPORT_BRANCH) private readonly reportBranch: string,
    @Inject(JOB_SERVICE) private readonly jobs: JobService,
    @Inject(ARTIFACT_TICKETS) private readonly tickets: TicketStore,
    @Inject(PUBLIC_BASE_URL) private readonly baseUrl: string,
  ) {}

  @Get("general")
  general(): GeneralReportView {
    return this.view(this.defaultProject());
  }

  /**
   * The link to hand someone with no login — on demand, instead of waiting for a job to finish
   * (that is the only other place a general-report ticket gets minted, in `notifyOnFinish`). Needs a
   * real session/API key itself (same guard as `GET general`): this is where an admin goes to get the
   * shareable link, not something to expose anonymously.
   */
  @Get("general/link")
  link(): { url: string } {
    const ticket = this.tickets.issue(GENERAL_REPORT_TICKET_SUBJECT);
    return { url: `${this.baseUrl}/v1/report/general/html?ticket=${encodeURIComponent(ticket)}` };
  }

  /**
   * The public, no-login page a webhook's `links.report` points at by default. Every row's "Ver
   * reporte" link carries that job's own ticket too (a fresh `tickets.issue(jobId)` call — fine even
   * if it differs from the one that job's own `onFinished` run minted, since every valid ticket for a
   * job resolves the same way), so this page stays fully openable without a session end to end, not
   * just at the top level.
   */
  @Public()
  @UseGuards(GeneralReportAccessGuard)
  @Get("general/html")
  generalHtml(@Res() res: Response): void {
    const view = this.view(this.defaultProject());
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtml(view, (jobId) => this.tickets.issue(jobId)));
  }

  private defaultProject(): string {
    return this.jobs.projects()[0]?.id ?? "";
  }

  private view(project: string): GeneralReportView {
    return { project, branch: this.reportBranch, scenarios: this.store.list(project, this.reportBranch).map(toView) };
  }
}
