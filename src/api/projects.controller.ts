import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { Roles } from "../auth/access-control";
import type { CatalogTarget } from "../core/adapter";
import { JOB_SERVICE, type JobService } from "../core/job-service";
import { parseBrowse } from "./request-parsing";

interface ProjectView {
  readonly id: string;
  readonly defaultBranch: string;
  readonly allowedBranches: readonly string[];
}

/**
 * Scoped to `e2e-mobile` because Detox is the only project today; a request on the shared API key
 * (the CLI, n8n) is unaffected — `@Roles` only restricts a web login session, never a service key.
 */
@Roles("e2e-mobile")
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

  /** Brings new branches from the remote into the project's catalog. */
  @Post(":id/fetch")
  @HttpCode(200)
  async fetch(@Param("id") id: string): Promise<Record<string, never>> {
    await this.jobs.catalogOf(id).fetch();
    return {};
  }

  @Get(":id/refs")
  async refs(@Param("id") id: string): Promise<{ refs: string[] }> {
    return { refs: [...(await this.jobs.catalogOf(id).refs())] };
  }

  /** Positions the project's one browsing folder on this branch's commit. Never touches a running job's folder. */
  @Post(":id/browse")
  @HttpCode(200)
  async browse(@Param("id") id: string, @Body() body: unknown): Promise<{ ref: string; sha: string }> {
    const ref = parseBrowse(body);
    const { sha } = await this.jobs.catalogOf(id).browse(ref);
    return { ref, sha };
  }

  /** What can be queued on whatever branch `browse` last positioned the catalog at. */
  @Get(":id/targets")
  async targets(@Param("id") id: string): Promise<{ targets: readonly CatalogTarget[] }> {
    return { targets: await this.jobs.catalogOf(id).targets() };
  }
}
