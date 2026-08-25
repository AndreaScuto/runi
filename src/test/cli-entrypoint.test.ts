import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("compiled CLI executes when invoked directly", () => {
  const result = spawnSync(process.execPath, [resolve("dist", "cli.js"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runi 0\.1/);
  assert.match(result.stdout, /runi start/);
});
