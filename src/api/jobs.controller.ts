import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ArtifactAccessGuard } from "./artifact-access.guard";
import { Public, Roles } from "../auth/access-control";
import { STREAM_TICKETS, StreamTickets } from "../auth/stream-ticket";
import { DIAGNOSTICS, type Diagnostics } from "../core/diagnostics";
import { JOB_LOG_READER, type JobLogReader, type LogChunk } from "../core/job-log";
import { JOB_SERVICE, type JobService } from "../core/job-service";
import { toJobView, type JobView } from "./job-view";
import { parseList, parseLogFrom, parseSubmit } from "./request-parsing";

/** The file `findRunReport`'s folder (`job.reportPath`) actually holds — see that function's own doc. */
const REPORT_FILE = "report.html";

/** Scoped to `e2e-mobile`; see `ProjectsController` for why, and why a service-key request is unaffected. */
@Roles("e2e-mobile")
@Controller("v1/jobs")
export class JobsController {
  constructor(
    @Inject(JOB_SERVICE) private readonly jobs: JobService,
    @Inject(JOB_LOG_READER) private readonly logs: JobLogReader,
    @Inject(STREAM_TICKETS) private readonly tickets: StreamTickets,
    @Inject(DIAGNOSTICS) private readonly diagnostics: Diagnostics,
  ) {}

  @Post()
  async submit(@Body() body: unknown): Promise<JobView> {
    const job = await this.jobs.submit(parseSubmit(body));
    return toJobView(job, this.jobs.waitingReasonFor(job.id));
  }

  @Get()
  list(@Query() query: Record<string, unknown>): { jobs: JobView[]; nextCursor: number | null } {
    const { filter, page } = parseList(query);
    const result = this.jobs.list(filter, page);
    return { jobs: result.jobs.map((job) => toJobView(job, this.jobs.waitingReasonFor(job.id))), nextCursor: result.nextCursor };
  }

  @Get(":id")
  get(@Param("id") id: string): JobView {
    const job = this.jobs.get(id);
    return toJobView(job, this.jobs.waitingReasonFor(job.id));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string): Promise<JobView> {
    const job = await this.jobs.cancel(id);
    return toJobView(job, this.jobs.waitingReasonFor(job.id));
  }

  @Post(":id/retry")
  async retry(@Param("id") id: string): Promise<JobView> {
    const job = await this.jobs.retry(id);
    return toJobView(job, this.jobs.waitingReasonFor(job.id));
  }

  @Get(":id/log")
  log(@Param("id") id: string, @Query() query: Record<string, unknown>): LogChunk {
    this.jobs.get(id); // 404 for an unknown job, same as every other :id route
    return this.logs.read(id, parseLogFrom(query));
  }

  /** A one-time, short-lived ticket to open .../stream: a WebSocket handshake cannot carry an Authorization header. */
  @Post(":id/stream-ticket")
  streamTicket(@Param("id") id: string): { ticket: string } {
    this.jobs.get(id);
    return { ticket: this.tickets.issue(id) };
  }

  /**
   * The scenario's real HTML report (`report.html` inside the folder `job.reportPath` points at — it
   * is a run's report *folder*, not the file itself, found by review: `createReadStream` on a
   * directory fails async with EISDIR, and with nothing listening for it, that is an uncaught
   * exception that kills the whole process, not just this request — reproduced before this fix).
   * `@Public()` + `ArtifactAccessGuard` replace the usual role-gated `AuthGuard`: a caller with the
   * normal credentials (API key or web session) works exactly as before, but this route also accepts
   * a `?ticket=` scoped to this one job, for a webhook link opened by someone with neither — see
   * `ArtifactTickets`' own doc for why.
   */
  @Public()
  @UseGuards(ArtifactAccessGuard)
  @Get(":id/report")
  report(@Param("id") id: string, @Res() res: Response): void {
    const job = this.jobs.get(id); // 404 for an unknown job, same as every other :id route
    const htmlPath = job.reportPath ? path.join(job.reportPath, REPORT_FILE) : undefined;
    if (!htmlPath || !existsSync(htmlPath)) {
      throw new NotFoundException(`No report for job ${id}`);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${id}-report.html"`);
    const stream = createReadStream(htmlPath);
    // existsSync above is only a point-in-time check: a read error after this (permission revoked,
    // deleted in between, disk error) would otherwise be the same kind of unhandled stream 'error'
    // that the directory bug above was — so this is still needed even with the path fixed.
    stream.on("error", (error) => {
      this.diagnostics.error({ job: id, error: error.message }, "failed reading a job's report mid-stream");
      if (!res.headersSent) res.status(500).json({ statusCode: 500, error: "internal_error", message: "Internal server error" });
      else res.destroy();
    });
    stream.pipe(res);
  }
}
