import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { Roles } from "../auth/access-control";
import { STREAM_TICKETS, StreamTickets } from "../auth/stream-ticket";
import { JOB_LOG_READER, type JobLogReader, type LogChunk } from "../core/job-log";
import { JOB_SERVICE, type JobService } from "../core/job-service";
import { toJobView, type JobView } from "./job-view";
import { parseList, parseLogFrom, parseSubmit } from "./request-parsing";

/** Scoped to `e2e-mobile`; see `ProjectsController` for why, and why a service-key request is unaffected. */
@Roles("e2e-mobile")
@Controller("v1/jobs")
export class JobsController {
  constructor(
    @Inject(JOB_SERVICE) private readonly jobs: JobService,
    @Inject(JOB_LOG_READER) private readonly logs: JobLogReader,
    @Inject(STREAM_TICKETS) private readonly tickets: StreamTickets,
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
}
