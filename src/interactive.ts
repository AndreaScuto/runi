import { createInterface, emitKeypressEvents } from "node:readline";
import { isCancel, log, note, select, text } from "@clack/prompts";

const RESET = "\x1b[0m";
const LEO_YELLOW = "\x1b[38;2;255;192;0m";

const LEO_FACE = String.raw`   / \__
  (    @\___
  /         O
 /   (_____/
/_____/   U`;

export interface InteractiveChoice {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface InteractiveJob {
  id: string;
  label: string;
  hint?: string;
}

export interface InteractiveUi {
  brand(): void;
  command(): Promise<string | undefined>;
  choose(message: string, choices: readonly InteractiveChoice[], initialValue?: string): Promise<string | undefined>;
  input(message: string, placeholder?: string): Promise<string | undefined>;
  info(message: string, title?: string): void;
  error(message: string): void;
  close(): void;
}

export interface InteractiveActions {
  dispatch(argv: string[], ui: InteractiveUi): Promise<number>;
  jobs(): InteractiveJob[];
}

const COMMANDS: InteractiveChoice[] = [
  { value: "/guided", label: "/guided", hint: "Create a job with selectable settings" },
  { value: "/grill", label: "/grill", hint: "Refine an idea with AI choices" },
  { value: "/start", label: "/start", hint: "Run an existing task file" },
  { value: "/jobs", label: "/jobs", hint: "List durable jobs" },
  { value: "/inspect", label: "/inspect", hint: "Inspect a job and its evidence" },
  { value: "/logs", label: "/logs", hint: "Read a job's event log" },
  { value: "/pause", label: "/pause", hint: "Pause a job" },
  { value: "/resume", label: "/resume", hint: "Resume a paused job" },
  { value: "/stop", label: "/stop", hint: "Stop a job" },
  { value: "/settings", label: "/settings", hint: "Change workspace job defaults" },
  { value: "/doctor", label: "/doctor", hint: "Diagnose coding-agent setup" },
  { value: "/help", label: "/help", hint: "Show command help" },
  { value: "/exit", label: "/exit", hint: "Leave Runi" },
];

function colorsEnabled(): boolean {
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  return process.env.NO_COLOR === undefined && process.stdout.isTTY;
}

function accent(value: string): string {
  return colorsEnabled() ? `${LEO_YELLOW}${value}${RESET}` : value;
}

function brandedChoices(choices: readonly InteractiveChoice[]): InteractiveChoice[] {
  return choices.map((choice) => ({ ...choice, label: accent(choice.label) }));
}

export function readTerminalCommand(
  input: {
    isRaw?: boolean;
    setRawMode(value: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "keypress", listener: (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void): unknown;
    off(event: "keypress", listener: (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void): unknown;
  } = process.stdin,
  output: { write(value: string): unknown } = process.stdout,
): Promise<string | undefined> {
  emitKeypressEvents(input as NodeJS.ReadStream);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write(`${accent("Runi ›")} `);

  return new Promise((resolve) => {
    let value = "";
    const finish = (answer: string | undefined) => {
      input.off("keypress", onKeypress);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(answer);
    };
    const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c" || key.name === "escape") return finish(undefined);
      if (key.name === "return" || key.name === "enter") return finish(value.trim());
      if (key.name === "backspace") {
        if (value) {
          value = [...value].slice(0, -1).join("");
          output.write("\b \b");
        }
        return;
      }
      if (!character || key.ctrl || key.meta || /[\x00-\x1f\x7f]/.test(character)) return;
      output.write(character);
      if (value === "" && character === "/") return finish("/");
      value += character;
    };
    input.on("keypress", onKeypress);
  });
}

function terminalUi(): InteractiveUi {
  return {
    brand() {
      console.log(`${accent(LEO_FACE)}\n${accent("Runi 0.2 · Leo is supervising")}\n`);
    },
    command: () => readTerminalCommand(),
    async choose(message, choices, initialValue) {
      const answer = await select({
        message: accent(message),
        options: brandedChoices(choices),
        initialValue,
        maxItems: 8,
        withGuide: false,
      });
      return isCancel(answer) ? undefined : answer;
    },
    async input(message, placeholder) {
      const answer = await text({
        message: accent(message),
        ...(placeholder === undefined ? {} : { placeholder }),
        withGuide: false,
      });
      return isCancel(answer) ? undefined : answer.trim();
    },
    info(message, title = "Leo") {
      note(message, accent(title), { withGuide: false });
    },
    error(message) {
      log.error(message, { withGuide: false });
    },
    close() {
      console.log(accent("Leo is off duty. See you soon."));
    },
  };
}

function lineUi(): InteractiveUi {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const ask = async (message: string): Promise<string | undefined> => {
    process.stdout.write(message);
    const answer = await iterator.next();
    return answer.done ? undefined : answer.value.trim();
  };
  return {
    brand() {
      console.log(`${accent(LEO_FACE)}\n${accent("Runi 0.2 · Leo is supervising")}\n`);
    },
    command: () => ask("\nWhat should Runi do? "),
    async choose(message, choices, initialValue) {
      console.log(`\n${message}`);
      choices.forEach((choice, index) => console.log(`  ${index + 1}) ${choice.label}${choice.disabled ? ` [unavailable: ${choice.hint ?? "disabled"}]` : ""}`));
      const answer = await ask(`Select (${initialValue ?? choices[0]?.value ?? ""}): `);
      if (answer === undefined) return undefined;
      if (!answer) return initialValue ?? choices[0]?.value;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        const choice = choices[index - 1];
        return choice?.disabled ? undefined : choice?.value;
      }
      return choices.find((choice) => choice.value === answer && !choice.disabled)?.value;
    },
    input: (message) => ask(`${message}: `),
    info(message, title = "Leo") {
      console.log(`\n${title}\n${message}`);
    },
    error(message) {
      console.error(`runi: ${message}`);
    },
    close() {
      lines.close();
      console.log(accent("Leo is off duty. See you soon."));
    },
  };
}

export function createInteractiveUi(): InteractiveUi {
  return process.stdin.isTTY && process.stdout.isTTY ? terminalUi() : lineUi();
}

async function dispatch(actions: InteractiveActions, ui: InteractiveUi, argv: string[]): Promise<void> {
  try {
    const code = await actions.dispatch(argv, ui);
    if (code !== 0) ui.error(`Operation ended with exit code ${code}.`);
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
  }
}

async function selectedJob(actions: InteractiveActions, ui: InteractiveUi, operation: string): Promise<string | undefined> {
  const jobs = actions.jobs();
  if (jobs.length === 0) {
    ui.info("No durable jobs found in this directory.");
    return undefined;
  }
  return ui.choose(
    `Select a job to ${operation}`,
    jobs.map((job) => ({ value: job.id, label: job.label, ...(job.hint === undefined ? {} : { hint: job.hint }) })),
  );
}

export async function runInteractive(actions: InteractiveActions, ui = createInteractiveUi()): Promise<number> {
  ui.brand();
  try {
    while (true) {
      let command = await ui.command();
      if (command === undefined || command === "/exit") return 0;
      if (command === "") continue;
      if (command === "/") {
        command = await ui.choose("Slash commands", COMMANDS);
        if (command === undefined) continue;
        if (command === "/exit") return 0;
      }
      if (command === "/help") {
        ui.info(COMMANDS.map((item) => `${item.value.padEnd(10)} ${item.hint}`).join("\n"), "Slash commands");
        continue;
      }
      if (command === "/jobs") {
        await dispatch(actions, ui, ["status"]);
        continue;
      }
      if (command === "/settings") {
        await dispatch(actions, ui, ["settings"]);
        continue;
      }
      if (command === "/doctor") {
        await dispatch(actions, ui, ["doctor"]);
        continue;
      }
      if (command === "/guided" || command === "/grill") {
        const goal = await ui.input("What should Runi build?", "Describe the outcome");
        if (goal) await dispatch(actions, ui, ["start", goal, command === "/guided" ? "--guided" : "--grill"]);
        continue;
      }
      if (command === "/start") {
        const task = await ui.input("Task file", "task.md or task.json");
        if (task) await dispatch(actions, ui, ["start", task]);
        continue;
      }
      if (["/inspect", "/logs", "/pause", "/resume", "/stop"].includes(command)) {
        const operation = command.slice(1);
        const jobId = await selectedJob(actions, ui, operation);
        if (jobId) await dispatch(actions, ui, [operation, jobId]);
        continue;
      }
      if (!command.startsWith("/")) {
        await dispatch(actions, ui, ["start", command, "--guided"]);
        continue;
      }
      ui.error(`Unknown slash command: ${command}`);
    }
  } finally {
    ui.close();
  }
}
