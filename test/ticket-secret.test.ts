import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadOrCreateTicketSecret } from "../src/auth/ticket-secret";
import { scratchDir } from "./helpers/workspace";

describe("loadOrCreateTicketSecret", () => {
  it("creates a secret on first call and reads the same one back afterwards — the whole point: it must survive a restart", () => {
    const dataDir = scratchDir();
    const first = loadOrCreateTicketSecret(dataDir);
    const second = loadOrCreateTicketSecret(dataDir);
    assert.equal(first, second);
    assert.ok(first.length >= 32, "a short secret would make signatures forgeable");
  });

  it("gives two different installs (separate dataDirs) different secrets", () => {
    const a = loadOrCreateTicketSecret(scratchDir());
    const b = loadOrCreateTicketSecret(scratchDir());
    assert.notEqual(a, b);
  });

  it("creates dataDir itself if it does not exist yet", () => {
    const dataDir = path.join(scratchDir(), "nested", "data");
    assert.equal(fs.existsSync(dataDir), false);
    const secret = loadOrCreateTicketSecret(dataDir);
    assert.ok(fs.existsSync(dataDir));
    assert.equal(loadOrCreateTicketSecret(dataDir), secret);
  });
});
