import { AdapterRegistry } from "../../src/core/adapter";
import { JobEnqueuer } from "../../src/core/job-enqueuer";
import { JobScheduler } from "../../src/core/job-scheduler";
import { JobService, type ProjectPolicy } from "../../src/core/job-service";
import { openMemoryDatabase } from "../../src/db/open-database";
import { SqliteJobStore } from "../../src/db/sqlite-job-store";
import { fakeAdapter, type FakeAdapter } from "./fake-adapter";

export const policies: readonly ProjectPolicy[] = [
  { id: "detox", allowedBranches: ["main", "iteration_*"], defaultBranch: "iteration_1" },
  // configured, but with no adapter registered: as a project looks while its adapter is not built yet
  { id: "web", allowedBranches: ["main"], defaultBranch: "main" },
];

/** The whole core wired together over an in-memory database and a fake Detox adapter. */
export function buildService(adapter: FakeAdapter = fakeAdapter("detox", ["devices"])) {
  const db = openMemoryDatabase();
  const store = new SqliteJobStore(db);
  const adapters = new AdapterRegistry([adapter]);
  const scheduler = new JobScheduler(store, adapters);
  const service = new JobService(policies, adapters, new JobEnqueuer(store, adapters, scheduler), scheduler, store);
  return { db, store, scheduler, service, adapter };
}
