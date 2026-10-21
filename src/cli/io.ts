import readline from 'node:readline';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  prompt(question: string): Promise<string>;
}

export class CliError extends Error {
  constructor(message: string, readonly code: number = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export function realIo(): Io {
  return {
    out: (s) => void process.stdout.write(s + '\n'),
    err: (s) => void process.stderr.write(s + '\n'),
    prompt: (q) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          resolve(a);
        });
      }),
  };
}
