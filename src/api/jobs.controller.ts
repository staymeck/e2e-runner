import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { JOB_SERVICE, type JobService } from "../core/job-service";
import { toJobView, type JobView } from "./job-view";
import { parseList, parseSubmit } from "./request-parsing";

@Controller("v1/jobs")
export class JobsController {
  constructor(@Inject(JOB_SERVICE) private readonly jobs: JobService) {}

  @Post()
  async submit(@Body() body: unknown): Promise<JobView> {
    return toJobView(await this.jobs.submit(parseSubmit(body)));
  }

  @Get()
  list(@Query() query: Record<string, unknown>): { jobs: JobView[]; nextCursor: number | null } {
    const { filter, page } = parseList(query);
    const result = this.jobs.list(filter, page);
    return { jobs: result.jobs.map(toJobView), nextCursor: result.nextCursor };
  }

  @Get(":id")
  get(@Param("id") id: string): JobView {
    return toJobView(this.jobs.get(id));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Param("id") id: string): Promise<JobView> {
    return toJobView(await this.jobs.cancel(id));
  }

  @Post(":id/retry")
  retry(@Param("id") id: string): JobView {
    return toJobView(this.jobs.retry(id));
  }
}
