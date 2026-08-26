import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the scoped package is publicly installable from npm without GitHub login", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    publishConfig?: { registry?: string; access?: string };
  };
  const workflow = readFileSync(".github/workflows/publish-package.yml", "utf8");
  const npmrc = existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : "";

  assert.equal(pkg.publishConfig?.registry, "https://registry.npmjs.org");
  assert.equal(pkg.publishConfig?.access, "public");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm install --global npm@11\.5\.1/);
  assert.doesNotMatch(`${workflow}\n${npmrc}`, /npm\.pkg\.github\.com|secrets\.GITHUB_TOKEN/);
});
