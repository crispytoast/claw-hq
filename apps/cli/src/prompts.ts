/**
 * Tiny readline-based prompt helpers. One shared readline per wizard session
 * so piped input works (each call doesn't EOF the stream).
 */
import { createInterface, Interface as ReadlineInterface } from "node:readline";

export interface PromptSession {
  ask(question: string, defaultValue?: string): Promise<string>;
  askChoice<T extends string>(
    question: string,
    options: Array<{ value: T; label: string }>,
    defaultIndex?: number,
  ): Promise<T>;
  askPassword(question: string): Promise<string>;
  close(): void;
}

export function openPrompts(): PromptSession {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
    return new Promise((resolve) => {
      rl.question(`${question}${suffix} `, (answer) => {
        const trimmed = answer.trim();
        resolve(trimmed.length === 0 ? defaultValue ?? "" : trimmed);
      });
    });
  };

  const askChoice = async <T extends string>(
    question: string,
    options: Array<{ value: T; label: string }>,
    defaultIndex = 0,
  ): Promise<T> => {
    console.log(`\n${question}`);
    for (let i = 0; i < options.length; i++) {
      const marker = i === defaultIndex ? "*" : " ";
      console.log(`  ${marker} ${i + 1}) ${options[i]!.label}`);
    }
    const answer = await ask(`Pick a number 1-${options.length}:`, String(defaultIndex + 1));
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return options[idx]!.value;
    }
    console.log("Invalid choice, using default.");
    return options[defaultIndex]!.value;
  };

  const askPassword = (question: string): Promise<string> => {
    // For password input we use a raw-mode read instead of readline so chars don't echo.
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      if (!stdin.isTTY) {
        // Non-TTY: read a line via the shared readline (no masking).
        rl.question(`${question} `, (a) => resolve(a.trim()));
        return;
      }
      stdout.write(`${question} `);
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      let buf = "";
      const onData = (key: string) => {
        for (const ch of key) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode?.(wasRaw ?? false);
            stdin.pause();
            stdin.removeListener("data", onData);
            stdout.write("\n");
            resolve(buf);
            return;
          }
          if (ch === "") process.exit(130); // Ctrl+C
          if (ch === "" || ch === "\b") { buf = buf.slice(0, -1); continue; }
          buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  };

  const close = () => rl.close();

  return { ask, askChoice, askPassword, close };
}

export function note(text: string): void { console.log(text); }
export function header(text: string): void {
  console.log(`\n${text}`);
  console.log("─".repeat(Math.min(text.length, 60)));
}
