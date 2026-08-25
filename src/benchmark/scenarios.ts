import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface BenchmarkScenario {
  id: string;
  title: string;
  goal: string;
  sourceFile: string;
  source: string;
  visibleTest: string;
  acceptance: string;
}

const prelude = 'import assert from "node:assert/strict";\nimport test from "node:test";\n';

export const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "sum",
    title: "Implement numeric sum",
    goal: "Implement `sum(a, b)` in src/utils.js. It must return the arithmetic sum of two numbers. Do not change the tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function sum(a, b) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { sum } from "../src/utils.js";\ntest("sum", () => assert.equal(sum(2, 3), 5));\n`,
    acceptance: 'assert.equal(sum(0, 0), 0);\nassert.equal(sum(-4, 6), 2);\nassert.equal(sum(1.5, 2.5), 4);',
  },
  {
    id: "clamp",
    title: "Implement clamp",
    goal: "Implement `clamp(value, min, max)` in src/utils.js. It must return min below range, max above range, otherwise value. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function clamp(value, min, max) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { clamp } from "../src/utils.js";\ntest("clamp", () => assert.equal(clamp(9, 0, 5), 5));\n`,
    acceptance: 'assert.equal(clamp(-1, 0, 5), 0);\nassert.equal(clamp(3, 0, 5), 3);\nassert.equal(clamp(5, 0, 5), 5);',
  },
  {
    id: "slugify",
    title: "Implement slugification",
    goal: "Implement `slugify(value)` in src/utils.js. Lowercase input, trim it, convert every run of non-alphanumeric characters to one hyphen, and remove leading/trailing hyphens. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function slugify(value) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { slugify } from "../src/utils.js";\ntest("slugify", () => assert.equal(slugify("Hello World"), "hello-world"));\n`,
    acceptance: 'assert.equal(slugify("  Hello, World!  "), "hello-world");\nassert.equal(slugify("A---B___C"), "a-b-c");\nassert.equal(slugify("already-a-slug"), "already-a-slug");',
  },
  {
    id: "unique",
    title: "Implement stable unique values",
    goal: "Implement `unique(values)` in src/utils.js. Return the first occurrence of each value in original order. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function unique(values) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { unique } from "../src/utils.js";\ntest("unique", () => assert.deepEqual(unique([1, 1, 2]), [1, 2]));\n`,
    acceptance: 'assert.deepEqual(unique([]), []);\nassert.deepEqual(unique(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);\nassert.deepEqual(unique([true, false, true]), [true, false]);',
  },
  {
    id: "parse-boolean",
    title: "Parse environment booleans",
    goal: "Implement `parseBoolean(value, fallback = false)` in src/utils.js. Accept true, 1, yes and on (case-insensitive) as true; false, 0, no and off as false; return fallback for any other value. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function parseBoolean(value, fallback = false) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { parseBoolean } from "../src/utils.js";\ntest("parseBoolean", () => assert.equal(parseBoolean("yes"), true));\n`,
    acceptance: 'assert.equal(parseBoolean("OFF"), false);\nassert.equal(parseBoolean("1"), true);\nassert.equal(parseBoolean("unknown", true), true);\nassert.equal(parseBoolean(undefined), false);',
  },
  {
    id: "range",
    title: "Implement inclusive range",
    goal: "Implement `range(start, end)` in src/utils.js. Return an inclusive integer range in ascending or descending order. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function range(start, end) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { range } from "../src/utils.js";\ntest("range", () => assert.deepEqual(range(1, 3), [1, 2, 3]));\n`,
    acceptance: 'assert.deepEqual(range(0, 0), [0]);\nassert.deepEqual(range(3, 1), [3, 2, 1]);\nassert.deepEqual(range(-1, 1), [-1, 0, 1]);',
  },
  {
    id: "flatten-one",
    title: "Flatten one array level",
    goal: "Implement `flattenOne(values)` in src/utils.js. Flatten exactly one array nesting level without mutating input. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function flattenOne(values) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { flattenOne } from "../src/utils.js";\ntest("flattenOne", () => assert.deepEqual(flattenOne([1, [2, 3]]), [1, 2, 3]));\n`,
    acceptance: 'assert.deepEqual(flattenOne([]), []);\nassert.deepEqual(flattenOne([[1], [2], 3]), [1, 2, 3]);\nassert.deepEqual(flattenOne([1, [[2]]]), [1, [2]]);',
  },
  {
    id: "palindrome",
    title: "Implement palindrome check",
    goal: "Implement `isPalindrome(value)` in src/utils.js. Ignore case and non-alphanumeric characters. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function isPalindrome(value) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { isPalindrome } from "../src/utils.js";\ntest("isPalindrome", () => assert.equal(isPalindrome("level"), true));\n`,
    acceptance: 'assert.equal(isPalindrome("A man, a plan, a canal: Panama!"), true);\nassert.equal(isPalindrome("Not a palindrome"), false);\nassert.equal(isPalindrome(""), true);',
  },
  {
    id: "mean",
    title: "Implement arithmetic mean",
    goal: "Implement `mean(values)` in src/utils.js. Return the arithmetic mean of numeric values; return 0 for an empty array. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function mean(values) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { mean } from "../src/utils.js";\ntest("mean", () => assert.equal(mean([2, 4]), 3));\n`,
    acceptance: 'assert.equal(mean([]), 0);\nassert.equal(mean([1, 2, 3]), 2);\nassert.equal(mean([-2, 2]), 0);',
  },
  {
    id: "parse-port",
    title: "Validate a TCP port",
    goal: "Implement `parsePort(value)` in src/utils.js. Parse a base-10 integer from a string or number. It must return an integer from 1 to 65535, and throw RangeError for invalid, decimal, zero, negative or out-of-range values. Do not change tests or package configuration.",
    sourceFile: "src/utils.js",
    source: "export function parsePort(value) {\n  throw new Error('not implemented');\n}\n",
    visibleTest: `${prelude}import { parsePort } from "../src/utils.js";\ntest("parsePort", () => assert.equal(parsePort("3000"), 3000));\n`,
    acceptance: 'assert.equal(parsePort(65535), 65535);\nassert.throws(() => parsePort("0"), RangeError);\nassert.throws(() => parsePort("12.5"), RangeError);\nassert.throws(() => parsePort("70000"), RangeError);',
  },
];

export async function createScenarioWorkspace(
  workspace: string,
  acceptancePath: string,
  scenario: BenchmarkScenario,
): Promise<void> {
  const sourcePath = join(workspace, scenario.sourceFile);
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: `runi-benchmark-${scenario.id}`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
  await writeFile(sourcePath, scenario.source);
  await writeFile(join(workspace, "test", "utils.test.js"), scenario.visibleTest);
  const moduleUrl = pathToFileURL(sourcePath).href;
  const acceptance = `${prelude}import * as target from ${JSON.stringify(moduleUrl)};\nconst { ${exportName(scenario.source)} } = target;\n${scenario.acceptance}\n`;
  await writeFile(acceptancePath, acceptance);
}

function exportName(source: string): string {
  const match = /export function (\w+)/.exec(source);
  if (!match?.[1]) throw new Error("Scenario source must export one function.");
  return match[1];
}
