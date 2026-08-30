import readline from "node:readline";

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const ENTER = new Set(["\n", "\r"]);
const CTRL_C = "\x03";
const BACKSPACE = new Set(["\x7f", "\b"]);

/**
 * Prompts for a password without echoing it to the terminal. Processes
 * input one character at a time rather than treating a whole chunk as one
 * unit, since a pasted password or fast typing can deliver several
 * characters (or a paste plus Enter) in a single "data" event.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.resume();
    stdin.setRawMode?.(true);

    let value = "";
    const finish = (result: string | null) => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (result === null) {
        process.exit(130);
      }
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === CTRL_C) return finish(null);
        if (ENTER.has(char)) return finish(value);
        if (BACKSPACE.has(char)) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}
