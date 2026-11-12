/**
 * In stdio mode stdout is the JSON-RPC channel. Dependencies that run in this process (libsignal under Baileys)
 * call console.info/log ("Closing session: <SessionEntry>") on Signal session events; that text lands on stdout
 * and the client drops the connection ("Invalid JSON-RPC message from child"). Those calls also dump session
 * objects (key material), so console.warn is muted too rather than sent to stderr, which Claude Desktop logs.
 * console.error stays: it goes to stderr and carries real failures.
 */
export const MUTED_CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'trace', 'dir', 'dirxml', 'table'] as const;

export function muteConsoleForStdio(target: Console = console): void {
  const noop = (): void => {};
  for (const m of MUTED_CONSOLE_METHODS) {
    (target as unknown as Record<string, unknown>)[m] = noop;
  }
}
