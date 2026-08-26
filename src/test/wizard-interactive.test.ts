import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGuidedTask } from "../wizard.js";

test("guided authoring selects finite options instead of typing them", async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-select-"));
  const selectedQuestions: string[] = [];
  try {
    const path = await createGuidedTask("Add a health endpoint", workingDirectory, async (question) => {
      if (question.startsWith("Executable override") || question.startsWith("Model override")) return "";
      if (question.startsWith("Verification shell command")) {
        assert.match(question, /python .*\.py/i);
        return "node --test";
      }
      if (question.startsWith("Add another verification")) return "";
      throw new Error(`Unexpected typed option: ${question}`);
    }, {
      choose: async (question: string, options: readonly string[]) => {
        selectedQuestions.push(question);
        if (question === "Worker agent") return "codex";
        if (question === "Maximum attempts") return "2";
        if (question === "Wall-time budget") return "1h";
        if (question === "Verification policy") return "manual";
        throw new Error(`Unexpected selection: ${question} (${options.join(", ")})`);
      },
    } as Parameters<typeof createGuidedTask>[3]);

    const task = JSON.parse(readFileSync(path, "utf8")) as {
      executor: { kind: string };
      budget: { maxAttempts: number; wallTime: string };
      verification: string[];
    };
    assert.deepEqual(selectedQuestions, ["Worker agent", "Maximum attempts", "Wall-time budget", "Verification policy"]);
    assert.equal(task.executor.kind, "codex");
    assert.deepEqual(task.budget, { maxAttempts: 2, wallTime: "1h" });
    assert.deepEqual(task.verification, ["node --test"]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("guided authoring uses workspace settings as editable defaults", async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-defaults-"));
  const initialValues: Record<string, string | undefined> = {};
  try {
    const path = await createGuidedTask("Add caching", workingDirectory, async (question) => {
      if (question.startsWith("Executable override") || question.startsWith("Model override")) return "";
      if (question.startsWith("Verification shell command")) return "node --test";
      if (question.startsWith("Add another verification")) return "";
      throw new Error(`Unexpected typed option: ${question}`);
    }, {
      defaults: {
        agent: "codex",
        model: "gpt-5.4",
        maxAttempts: 2,
        wallTime: "2h",
        verificationPolicy: "manual",
      },
      choose: async (question: string, _options: readonly string[], initialValue?: string) => {
        initialValues[question] = initialValue;
        return initialValue ?? "";
      },
    } as Parameters<typeof createGuidedTask>[3]);

    const task = JSON.parse(readFileSync(path, "utf8")) as {
      executor: { kind: string; model?: string };
      budget: { maxAttempts: number; wallTime: string };
    };
    assert.deepEqual(initialValues, {
      "Worker agent": "codex",
      "Maximum attempts": "2",
      "Wall-time budget": "2h",
      "Verification policy": "manual",
    });
    assert.deepEqual(task.executor, { kind: "codex", model: "gpt-5.4" });
    assert.deepEqual(task.budget, { maxAttempts: 2, wallTime: "2h" });
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("Codex authoring asks before trusting the selected working directory", async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "runi-trust-"));
  let confirmed = false;
  try {
    await createGuidedTask("Add a health endpoint", workingDirectory, async (question) => {
      if (question.startsWith("Executable override") || question.startsWith("Model override")) return "";
      if (question.startsWith("Verification shell command")) return "node --test";
      if (question.startsWith("Add another verification")) return "";
      throw new Error(`Unexpected prompt: ${question}`);
    }, {
      choose: async (question: string) => {
        if (question === "Worker agent") return "codex";
        if (question === "Maximum attempts") return "1";
        if (question === "Wall-time budget") return "30m";
        if (question === "Verification policy") return "manual";
        throw new Error(`Unexpected selection: ${question}`);
      },
      confirmWorkspace: async (path: string) => {
        confirmed = true;
        assert.equal(path, workingDirectory);
        return true;
      },
    } as Parameters<typeof createGuidedTask>[3]);

    assert.equal(confirmed, true);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});
