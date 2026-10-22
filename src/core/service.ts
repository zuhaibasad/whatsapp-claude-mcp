// Contracts for the background service, its local control API, the setup UI and the installer.
// Owned by the orchestrator. See docs/PLAN.md §11 and docs/research/R1–R3.
import type { ChatRow } from './contracts.js';

// ---------- setup state machine (shared by service, MCP and UI) ----------

export type SetupStep =
  | 'needs_accept'   // risk warning not yet accepted (meta.risk_accepted_at missing)
  | 'ready_to_link'  // accepted + key + store exist, not linked
  | 'linking'        // link in progress: QR available
  | 'syncing'        // linked, receiving initial sync (settle window)
  | 'choose_chats'   // sync done, waiting for the user's chat selection
  | 'done'           // linked, selection saved (or skipped)
  | 'error';

export interface SetupState {
  step: SetupStep;
  /** QR as an SVG string while step = linking; null otherwise. Never sent to the model. */
  qrSvg: string | null;
  /** Seconds until the current QR expires (approx.). */
  qrExpiresIn: number | null;
  account: { id: string; pushName: string | null } | null;
  sync: { chats: number; messages: number } | null;
  autostart: { supported: boolean; enabled: boolean };
  error: string | null;
  serviceVersion: string;
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
 * Operations the setup UI and MCP server can ask the service to perform.
 * Each op is exposed twice: as an HTTP route on the service (POST /api/<op>, JSON body/response)
 * and, for the Desktop panel, as an app-only MCP tool that proxies to the same HTTP route.
 */
export interface SetupOps {
  state(): Promise<SetupState>;
  /** Records risk acceptance. Only callable with a user-proof credential (panel nonce or browser session). */
  acceptRisk(): Promise<SetupState>;
  /** Creates key/store/config if missing, then starts linking (QR). Requires acceptance. */
  startLink(): Promise<SetupState>;
  cancelLink(): Promise<SetupState>;
  /** Rows for the picker (available in choose_chats and done). */
  chatRows(): Promise<ChatRow[]>;
  /** Saves the selection; null = keep defaults. Moves choose_chats -> done. */
  submitSelection(selectedIds: string[] | null): Promise<SelectionSummary | null>;
  setAutostart(enabled: boolean): Promise<SetupState>;
}

export type SetupOpName = keyof SetupOps;

// ---------- service discovery + auth ----------

/** Written by the service to `<dataDir>/service.json` on start; removed on clean exit. */
export interface ServiceInfo {
  pid: number;
  port: number;          // 127.0.0.1 only
  version: string;
  startedAt: number;     // unix seconds
}

/**
 * Credentials:
 * - Control token (MCP/CLI -> service): random 32 bytes, base64url, stored in the OS keychain under
 *   service KEYCHAIN_SERVICE, account `${keychainAccountId(dataDir)}:service-token`. Sent as
 *   `Authorization: Bearer <token>`. Grants every op EXCEPT acceptRisk.
 * - Browser session: GET /setup?t=<one-time token> (minted by the service when it opens the browser itself;
 *   never returned to the model) -> HttpOnly SameSite=Strict cookie -> page. POSTs need the cookie +
 *   `X-CSRF` header (value embedded in the page). Grants every op including acceptRisk.
 * - Panel nonce (Desktop MCP App): minted per resources/read of the setup ui:// resource, embedded only in
 *   that HTML, single-use for acceptRisk, 10 min TTL; the MCP server forwards it as `X-Accept-Nonce`.
 *   The MCP server obtains nonces from the service via POST /api/mint-nonce (control token).
 * - Every request: Host must be 127.0.0.1:<port>; browser POSTs must have Origin http://127.0.0.1:<port>.
 */
export const SERVICE_TOKEN_SUFFIX = ':service-token';

// ---------- installer (Windows first) ----------

export interface InstallStatus {
  installedVersion: string | null;   // version folder the scheduled task points to
  taskRegistered: boolean;
  running: boolean;                  // service.json pid alive and /api/health answers
}

export interface Installer {
  status(): Promise<InstallStatus>;
  /**
   * Copies the payload (runtime/node.exe + app) to `<dataDir>/app/<version>/` if missing, writes the hidden
   * launcher, registers the per-user logon task (no admin), and starts it. Idempotent; upgrades when the
   * bundled version differs (stops old service via POST /api/shutdown first).
   */
  ensureService(opts: { autostart: boolean }): Promise<InstallStatus>;
  setAutostart(enabled: boolean): Promise<void>;
  /** Stops the service, removes the task and app folders. Data is removed only if removeData. */
  uninstall(opts: { removeData: boolean }): Promise<void>;
}
