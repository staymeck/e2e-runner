import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../src/app";
import type { ServiceConfig } from "../src/config/service-config";
import { buildService } from "./helpers/service";

const newJobs = () => buildService().service;

const KEY = "current-key-0123456789";
const NEXT_KEY = "next-key-0123456789ab";
const MOBILE_PASSWORD = "mobile-pw-very-long";
const CYPRESS_PASSWORD = "cypress-pw-very-long";
const ADMIN_PASSWORD = "admin-pw-very-long";

const config: ServiceConfig = {
  server: { host: "127.0.0.1", port: 0 },
  apiKeys: [KEY, NEXT_KEY],
  webUsers: [
    { username: "mobile-user", password: MOBILE_PASSWORD, role: "e2e-mobile" },
    { username: "cypress-user", password: CYPRESS_PASSWORD, role: "e2e-cypress" },
    { username: "root", password: ADMIN_PASSWORD, role: "admin" },
  ],
  dataDir: "/unused",
  projects: [],
  detox: undefined,
};

describe("shutdown", () => {
  it("runs the registered callbacks once, even if one of them throws", async () => {
    const calls: string[] = [];
    const app = await createApp(config, {
      jobs: newJobs(),
      onShutdown: [
        () => {
          calls.push("first");
          throw new Error("boom");
        },
        () => {
          calls.push("second");
        },
      ],
    });
    await app.close();
    assert.deepEqual(calls, ["first", "second"]);
  });

  it("waits for each asynchronous callback before running the next (drain, then close the database)", async () => {
    const calls: string[] = [];
    const app = await createApp(config, {
      jobs: newJobs(),
      onShutdown: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          calls.push("drained");
        },
        () => {
          calls.push("closed");
        },
      ],
    });
    await app.close();
    assert.deepEqual(calls, ["drained", "closed"]);
  });
});

describe("HTTP API", () => {
  let app: INestApplication;
  let base: string;

  before(async () => {
    app = await createApp(config, { jobs: newJobs() });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(() => app.close());

  const get = (path: string, authorization?: string) => fetch(`${base}${path}`, authorization ? { headers: { authorization } } : {});
  const post = (path: string, body?: unknown, authorization?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string, password: string): Promise<string> => {
    const response = await post("/v1/auth/login", { username, password });
    assert.equal(response.status, 201, username);
    return ((await response.json()) as { token: string }).token;
  };

  it("answers /v1/health to a request with a valid key", async () => {
    const response = await get("/v1/health", `Bearer ${KEY}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("accepts the second key while a key is being rotated", async () => {
    assert.equal((await get("/v1/health", `Bearer ${NEXT_KEY}`)).status, 200);
  });

  it("rejects a request without credentials", async () => {
    assert.equal((await get("/v1/health")).status, 401);
  });

  it("rejects wrong keys and other schemes", async () => {
    for (const header of ["Bearer nope", `Basic ${KEY}`, `Bearer`, KEY, `Bearer ${KEY} extra`]) {
      assert.equal((await get("/v1/health", header)).status, 401, header);
    }
  });

  it("answers 404 to routes that do not exist, with or without a key", async () => {
    assert.equal((await get("/v1/anything")).status, 404);
    assert.equal((await get("/v1/anything", `Bearer ${KEY}`)).status, 404);
  });

  it("does not take the key from the URL", async () => {
    assert.equal((await get(`/v1/health?token=${KEY}&key=${KEY}`)).status, 401);
  });
});

describe("web login", () => {
  let app: INestApplication;
  let base: string;

  before(async () => {
    app = await createApp(config, { jobs: newJobs() });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(() => app.close());

  const get = (path: string, authorization?: string) => fetch(`${base}${path}`, authorization ? { headers: { authorization } } : {});
  const post = (path: string, body?: unknown, authorization?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string, password: string): Promise<string> => {
    const response = await post("/v1/auth/login", { username, password });
    assert.equal(response.status, 201, username);
    return ((await response.json()) as { token: string }).token;
  };

  it("logs a configured user in and lets their session reach a route with no role restriction", async () => {
    const token = await login("mobile-user", MOBILE_PASSWORD);
    assert.equal((await get("/v1/health", `Bearer ${token}`)).status, 200);
  });

  it("rejects an unknown username and a wrong password the same way", async () => {
    assert.equal((await post("/v1/auth/login", { username: "mobile-user", password: "wrong" })).status, 401);
    assert.equal((await post("/v1/auth/login", { username: "ghost", password: MOBILE_PASSWORD })).status, 401);
    assert.equal((await post("/v1/auth/login", { username: "ghost" })).status, 401);
  });

  it("lets e2e-mobile and admin sessions reach a route scoped to e2e-mobile, but not e2e-cypress", async () => {
    assert.equal((await get("/v1/projects", `Bearer ${await login("mobile-user", MOBILE_PASSWORD)}`)).status, 200);
    assert.equal((await get("/v1/projects", `Bearer ${await login("root", ADMIN_PASSWORD)}`)).status, 200);
    assert.equal((await get("/v1/projects", `Bearer ${await login("cypress-user", CYPRESS_PASSWORD)}`)).status, 403);
  });

  it("reports who is logged in via /v1/auth/me, for a session and for the shared API key", async () => {
    const token = await login("mobile-user", MOBILE_PASSWORD);
    assert.deepEqual(await (await get("/v1/auth/me", `Bearer ${token}`)).json(), { kind: "user", username: "mobile-user", role: "e2e-mobile" });
    assert.deepEqual(await (await get("/v1/auth/me", `Bearer ${KEY}`)).json(), { kind: "service" });
  });

  it("revokes the session on logout: the same token stops working right after", async () => {
    const token = await login("mobile-user", MOBILE_PASSWORD);
    assert.equal((await post("/v1/auth/logout", undefined, `Bearer ${token}`)).status, 204);
    assert.equal((await get("/v1/health", `Bearer ${token}`)).status, 401);
  });

  it("never lets a session token double as an API key or vice versa", async () => {
    const token = await login("mobile-user", MOBILE_PASSWORD);
    assert.equal((await get("/v1/health", `Bearer ${KEY}-${token}`)).status, 401);
  });
});
