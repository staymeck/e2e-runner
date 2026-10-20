import { Controller, Get, Inject } from "@nestjs/common";
import { JOB_SERVICE, type JobService } from "../core/job-service";

interface ProjectView {
  readonly id: string;
  readonly defaultBranch: string;
  readonly allowedBranches: readonly string[];
}

@Controller("v1/projects")
export class ProjectsController {
  constructor(@Inject(JOB_SERVICE) private readonly jobs: JobService) {}

  /** The repository URL stays out: the API shows what a caller can choose, not how the service reaches it. */
  @Get()
  list(): { projects: ProjectView[] } {
    return {
      projects: this.jobs.projects().map(({ id, defaultBranch, allowedBranches }) => ({ id, defaultBranch, allowedBranches })),
    };
  }
}
