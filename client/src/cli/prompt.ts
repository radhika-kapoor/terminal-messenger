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

// Bytes read past the Enter that finished the previous prompt — a single
// "data" event can contain more than one line (paste, fast typing, or
// piped/scripted input), so they must carry over to the next promptHidden()
// call rather than being dropped.
let leftover = "";

/**
 * Prompts for a password without echoing it to the terminal. Processes
 * input one character at a time rather than treating a whole chunk as one
 * unit, since a pasted password or fast typing can deliver several
 * characters — or a full line plus the start of the next one — in a
 * single "data" event.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.resume();
    stdin.setRawMode?.(true);

    let value = "";

    function finish(result: string | null): void {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (result === null) {
        process.exit(130);
      }
      resolve(result);
    }

    // Returns true once this prompt is resolved, so the caller stops feeding it more text.
    function consume(text: string): boolean {
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === CTRL_C) {
          finish(null);
          return true;
        }
        if (ENTER.has(char)) {
          leftover = text.slice(i + 1);
          finish(value);
          return true;
        }
        if (BACKSPACE.has(char)) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
      return false;
    }

    function onData(chunk: Buffer): void {
      consume(chunk.toString("utf8"));
    }

    if (leftover) {
      const pending = leftover;
      leftover = "";
      if (consume(pending)) return;
    }

    stdin.on("data", onData);
  });
}
