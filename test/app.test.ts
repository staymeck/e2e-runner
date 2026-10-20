import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../src/app";
import type { ServiceConfig } from "../src/config/service-config";

const KEY = "current-key-0123456789";
const NEXT_KEY = "next-key-0123456789ab";

const config: ServiceConfig = {
  server: { host: "127.0.0.1", port: 0 },
  apiKeys: [KEY, NEXT_KEY],
  dataDir: "/unused",
  projects: [],
  detox: undefined,
};

describe("HTTP API", () => {
  let app: INestApplication;
  let base: string;

  before(async () => {
    app = await createApp(config);
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(() => app.close());

  const get = (path: string, authorization?: string) => fetch(`${base}${path}`, authorization ? { headers: { authorization } } : {});

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
