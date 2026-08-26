import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readTerminalCommand, runInteractive, type InteractiveUi } from "../interactive.js";

test("pressing slash opens commands immediately without Enter", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): typeof input;
  };
  input.isTTY = true;
  input.isRaw = false;
  const rawModes: boolean[] = [];
  input.setRawMode = (value) => {
    input.isRaw = value;
    rawModes.push(value);
    return input;
  };
  const output = new PassThrough();

  const answer = readTerminalCommand(input, output);
  input.write("/");

  assert.equal(await answer, "/");
  assert.deepEqual(rawModes, [true, false]);
});

test("slash-command session stays open and selects persisted jobs", async () => {
  const commands = ["/help", "/inspect", "/exit"];
  const information: string[] = [];
  const dispatched: string[][] = [];
  const ui: InteractiveUi = {
    brand() {},
    command: async () => commands.shift(),
    choose: async (_message, choices) => choices[0]?.value,
    input: async () => undefined,
    info: (message) => information.push(message),
    error: (message) => assert.fail(message),
    close() {},
  };

  const code = await runInteractive({
    dispatch: async (argv) => {
      dispatched.push(argv);
      return 0;
    },
    jobs: () => [{ id: "rn_persisted", label: "WORKING · Test job" }],
  }, ui);

  assert.equal(code, 0);
  assert.match(information[0] ?? "", /\/guided/);
  assert.doesNotMatch(information[0] ?? "", /\/agents/);
  assert.deepEqual(dispatched, [["inspect", "rn_persisted"]]);
});

test("plain input starts the default guided job while slash commands stay explicit", async () => {
  const commands = ["Build a health endpoint", "/settings", "/exit"];
  const dispatched: string[][] = [];
  const ui: InteractiveUi = {
    brand() {},
    command: async () => commands.shift(),
    choose: async () => undefined,
    input: async () => undefined,
    info() {},
    error: (message) => assert.fail(message),
    close() {},
  };

  const code = await runInteractive({
    dispatch: async (argv) => {
      dispatched.push(argv);
      return 0;
    },
    jobs: () => [],
  }, ui);

  assert.equal(code, 0);
  assert.deepEqual(dispatched, [
    ["start", "Build a health endpoint", "--guided"],
    ["settings"],
  ]);
});

test("entering slash alone opens the command picker", async () => {
  const commands = ["/", "/exit"];
  const selected: string[] = [];
  const ui: InteractiveUi = {
    brand() {},
    command: async () => commands.shift(),
    choose: async (message, choices) => {
      selected.push(message);
      assert.ok(choices.some((choice) => choice.value === "/doctor"));
      return "/help";
    },
    input: async () => undefined,
    info() {},
    error: (message) => assert.fail(message),
    close() {},
  };

  assert.equal(await runInteractive({ dispatch: async () => 0, jobs: () => [] }, ui), 0);
  assert.deepEqual(selected, ["Slash commands"]);
});

test("commands with observable wait time use the loading indicator", async () => {
  const commands = ["/jobs", "/exit"];
  const loading: string[] = [];
  const ui = {
    brand() {},
    command: async () => commands.shift(),
    choose: async () => undefined,
    input: async () => undefined,
    info() {},
    error: (message: string) => assert.fail(message),
    close() {},
    loading: async <T>(message: string, action: () => Promise<T>) => {
      loading.push(message);
      return action();
    },
  } as unknown as InteractiveUi;

  assert.equal(await runInteractive({ dispatch: async () => 0, jobs: () => [] }, ui), 0);
  assert.deepEqual(loading, ["Loading jobs"]);
});
