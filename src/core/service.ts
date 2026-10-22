// Contracts for the collector host (runs inside the MCP server process while Claude is open), its local
// control API, and the setup UI. Owned by the orchestrator. See docs/DECISIONS.md (2026-10-22) and docs/research/R1–R3.
import type { ChatRow } from './contracts.js';

// ---------- setup state machine (shared by host, MCP tools and UI) ----------

export type SetupStep =
  | 'needs_accept'   // risk warning not yet accepted (meta.risk_accepted_at missing)
  | 'ready_to_link'  // accepted; key + store exist; not linked
  | 'linking'        // link in progress: QR available
  | 'syncing'        // linked, receiving the initial sync (settle window)
  | 'choose_chats'   // initial sync done, waiting for the user's chat selection
  | 'done'           // linked and selection saved (or skipped)
  | 'error';

export type CollectorState =
  | 'not_linked'
  | 'connecting'
  | 'catching_up'    // connected, offline messages still arriving
  | 'live'           // caught up (receivedPendingNotifications + quiet period)
  | 'reconnecting'
  | 'logged_out'     // needs re-link
  | 'stopped';

export interface SetupState {
  step: SetupStep;
  /** QR as an SVG string while step = linking; null otherwise. Only ever sent to the setup UI, never to the model. */
  qrSvg: string | null;
  /** Seconds until the current QR is replaced (approx.). */
  qrExpiresIn: number | null;
  account: { id: string; pushName: string | null } | null;
  /** Counts received so far during syncing / after. */
  sync: { chats: number; messages: number } | null;
  collector: CollectorState;
  error: string | null;
  version: string;
}

export interface SelectionSummary {
  groupsSelected: number;
  groupsTotal: number;
  directSelected: number;
  directTotal: number;
  includeGroupsByDefault: boolean;
  includeDirectByDefault: boolean;
}

/**
 * Operations the setup UI and MCP tools ask the collector host to perform.
 * Each op is an HTTP route on the lock-holder's control server (POST /api/<op>, JSON in/out), and for the
 * Desktop panel also an app-only MCP tool that calls the same op (in-process if this process is the holder,
 * otherwise over HTTP).
 */
export interface SetupOps {
  state(): Promise<SetupState>;
  /** Records risk acceptance. Requires a user-proof credential (panel nonce or browser session). */
  acceptRisk(): Promise<SetupState>;
  /** Creates key/store/config if missing, then starts linking (QR). Requires prior acceptance. */
  startLink(): Promise<SetupState>;
  cancelLink(): Promise<SetupState>;
  /** Rows for the picker (available in choose_chats and done). */
  chatRows(): Promise<ChatRow[]>;
  /** Saves the selection; null = keep defaults. choose_chats -> done. */
  submitSelection(selectedIds: string[] | null): Promise<SelectionSummary | null>;
  /** Waits until collector is 'live' (or timeout). Used before briefs. */
  waitForSync(timeoutMs: number): Promise<{ collector: CollectorState; waitedMs: number }>;
}

export type SetupOpName = keyof SetupOps;

// ---------- lock holder discovery + auth ----------

/** Written by the lock holder to `<dataDir>/service.json` once its control server listens; removed on exit. */
export interface HostInfo {
  pid: number;
  port: number;          // bound to 127.0.0.1 only
  version: string;
  startedAt: number;     // unix seconds
}

/**
 * Credentials:
 * - Control token (other MCP processes / CLI -> holder): random 32 bytes base64url in the OS keychain, account
 *   `${keychainAccountId(dataDir)}${SERVICE_TOKEN_SUFFIX}`. Header `Authorization: Bearer <token>`.
 *   Grants every op EXCEPT acceptRisk.
 * - Browser session (Claude Code): the holder mints a one-time token and opens the browser ITSELF at
 *   http://127.0.0.1:<port>/setup?t=<token> (the token is never returned to the model). The page exchanges it
 *   for an HttpOnly SameSite=Strict cookie; POSTs also need an `X-CSRF` header embedded in the page.
 *   Grants every op including acceptRisk.
 * - Panel nonce (Desktop MCP App): minted per resources/read of the setup ui:// resource and embedded only
 *   in that HTML; single-use for acceptRisk; 10-minute TTL. Sent as `X-Accept-Nonce` / tool arg.
 * - Every request: Host header must be 127.0.0.1:<port>; browser POSTs must carry Origin http://127.0.0.1:<port>.
 */
export const SERVICE_TOKEN_SUFFIX = ':service-token';
