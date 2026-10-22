# R3 — Claude Desktop probe results (2026-10-22, Windows 11, Claude Desktop Store build)

The user installed a throwaway `.mcpb` (no WhatsApp code), ran its two tools, then removed it. The orchestrator checked the results from outside Desktop and cleaned up.

| Check | Result |
|---|---|
| Runtime | `process.execPath` = `Claude.exe` (Electron 44.7.2, Node v24.21.0). CWD = `C:\WINDOWS\system32`. |
| N-API native module (`@napi-rs/keyring`) | Loads and works inside Desktop. |
| File write to `%LOCALAPPDATA%` from inside Desktop | Landed in the **real** `%LOCALAPPDATA%`, with no MSIX redirection (nothing under `Packages\Claude_*\LocalCache`). |
| File written outside, read inside | Visible. |
| Keychain (Credential Manager) | Shared both ways: an inside write is readable outside, and an outside write is readable inside. |
| HTTP to `127.0.0.1:<port>` service outside Desktop | Works. |
| Detached child spawned by the MCP process | **Did not survive.** The marker was never written: Desktop kills the process tree. Claude's summary claimed it had been written, but that was a paraphrase of the planned behaviour, not a result. |
| MCP Apps panel (`ui://`, `text/html;profile=mcp-app`) | Renders in the chat. |
| App-only tool via `app.callServerTool` from a panel button | Works and returned `clickedAt`. |

## Consequences
1. **Data dir** `%LOCALAPPDATA%\wa-bridge` is shared by the service, the MCP server and the CLI. The MCP server keeps reading the encrypted store directly; no thin-client rewrite.
2. **The service cannot be a child of the MCP server.** It is started by Task Scheduler (`Register-ScheduledTask -AtLogOn` + `Start-ScheduledTask`), using a bundled pinned `node.exe` from `%LOCALAPPDATA%\wa-bridge\app\<version>\`.
3. **The MCP server also runs on the bundled `node.exe`** (`mcp_config.command`), to avoid depending on Electron-as-node and its `system32` CWD.
4. **In-chat panels are confirmed in Desktop.** Claude Code gets the browser page that the service serves.
5. **Still to verify inside Desktop:** that `powershell Register-ScheduledTask` called from the MCP process succeeds. If it does not, the fallback is an HKCU Run key plus a one-time "start service" step through `explorer.exe`.

## Addendum (2026-10-22, after the first real install): MSIX DOES redirect AppData
The installed 0.1.0 extension wrote its data to `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\wa-bridge`, not `%LOCALAPPDATA%\wa-bridge`. The probe looked fine only because the orchestrator had created the probe folder from outside first: MSIX writes to *existing* real AppData folders in place, but redirects *new* ones into the package. **Fix:** on Windows the data dir is `%USERPROFILE%\.wa-bridge` (outside AppData, not virtualized). On start, 0.1.x data is migrated from `%LOCALAPPDATA%\wa-bridge` as seen from inside Desktop, together with its keychain entry.
