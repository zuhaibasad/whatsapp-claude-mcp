# R2 - Packaging wa-bridge as a Claude Desktop Extension (.mcpb) + Windows background service

Date 2026-10-22. Tooling: `@anthropic-ai/mcpb` 2.1.2 (installed; manifest schemas read; `mcpb pack` run).
Prototype: scratchpad `r2/b` (manifest + server requiring both native modules).
Legend: [V]=verified here, [D]=official README/MANIFEST/schema, [U]=unverified/uncertain.

## Recommended approach
Ship ONE win32-x64-only, pruned .mcpb. Desktop launches `server/mcp.js` (stdio MCP) from the extension dir. The bundle also contains a pinned `runtime/node.exe` (Node 22 LTS) and the service code. On first MCP start (or an explicit setup tool), an installer step COPIES `runtime/` + `app/` into a stable, version-keyed dir `%LOCALAPPDATA%\wa-bridge\app\<version>\`, writes a hidden launcher, and registers a per-user Task Scheduler logon task pointing at that copy. The MCP server is a thin IPC client (127.0.0.1 port or named pipe) and never holds the WhatsApp socket or native modules. Do NOT depend on Desktop's Node path for the service. The service is the sole owner of the data dir.

## 1. Manifest essentials
- `server.type`: `python | node | binary` (v0.4 adds `uv`) [V schema]. `entry_point`: JS file. `mcp_config`: `{command, args, env, platform_overrides}`, `command` required [V].
- Substitutions [D]: `${__dirname}`, `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`, `${pathSeparator}` / `${/}`, `${user_config.KEY}`.
- `user_config` types [D]: `string|number|boolean|directory|file`; options `required, default, multiple, sensitive, min, max, title, description`.
- `compatibility` [V schema]: `claude_desktop` (min version string), `platforms` (`darwin|win32|linux`), `runtimes` (`node`, `python` semver ranges). Required manifest keys: name, version, description, author, server.
- README [D]: "Node.js ships with Claude for macOS and Windows"; bundle all `node_modules` (`npm install --omit=dev`).
- Size limits: none stated in README, MANIFEST.md, schema, or pack code [D/V]. No known hard cap.
- Built-in Node version and `process.execPath`: NOT documented [U]. Cannot say whether `command:"node"` is a real node.exe or Electron-as-node (claude.exe + ELECTRON_RUN_AS_NODE). Desktop here is an MSIX package (`Claude_pzs8sxrjxfjjc`) [V], whose install path embeds the version and changes on update, so its Node path is almost certainly not stable. Never put it in Task Scheduler.
- Action item (5 min, needs Desktop): install a probe .mcpb that writes `process.execPath`, `process.version`, `process.versions.modules`, `ELECTRON_RUN_AS_NODE` to a file. Resolves the biggest unknown.

## 2. Native modules in a bundle [V]
- Both are N-API (ABI-stable): better-sqlite3-multiple-ciphers prebuild exports `node_api_module_get_api_version_v1`; `@napi-rs/keyring` win32 binary exports `napi_register_module_v1`. No NODE_MODULE_VERSION-specific registration found. Works under any Node with N-API 8+ (Node 24 here reports napi 10).
- better-sqlite3-multiple-ciphers 13.0.3 ships all 8 platform prebuilds in `prebuilds/<platform>-<arch>.node` (2.2-3.2 MB each) plus `deps/` (14 MB sqlite sources) and `src/`. `@napi-rs/keyring` uses per-platform optional packages (`@napi-rs/keyring-win32-x64-msvc`, ~2 MB); npm installs only the host one, so build on Windows x64 or `npm i --omit=dev --os=win32 --cpu=x64`.
- `npx mcpb pack b out.mcpb` (manifest validated):
  - Unpruned: package 13.9 MB, unpacked 35.2 MB, 99 files.
  - Pruned (delete `deps/`, `src/`, non-win32-x64 prebuilds, `node-addon-api`): package 2.9 MB, unpacked 6.4 MB, 43 files; `require()` of both modules still works.
  - Add baileys/pino/zod/etc: expect ~10-15 MB; plus node.exe (see Q3).
- Consider esbuild-bundling pure JS to cut file count; keep `.node` files external.

## 3. Runtime for the background service
| Option | Pros | Cons |
|---|---|---|
| (a) Reuse Desktop's Node | 0 MB | Path/version unknown, unstable across MSIX updates, may be claude.exe-as-node, breaks if Desktop removed. Reject |
| (b) Ship node.exe | Pinned, tested version; stable once copied to LOCALAPPDATA; MIT license (include Node LICENSE); signed by OpenJS | ~80 MB unpacked, ~30 MB zipped; we track Node security updates |
| (c) Node SEA | single exe | `.node` addons can't live in the SEA blob (sidecar files + `process.dlopen`); ESM must be bundled to CJS; still ~80 MB; injected exe unsigned, AV/SmartScreen risk. Feasible in principle, not tested [U]; poor value |
| (d) Require user-installed Node | small | Breaks one-click. Reject |
**Pick (b)**, copied to `%LOCALAPPDATA%\wa-bridge\app\<ver>\runtime\node.exe`. Fallback if package size is a problem: download node.exe at first run with pinned SHA256.

## 4. Windows auto-start without admin
- `schtasks /Create /SC ONLOGON ...` as a standard user: **Access is denied** [V on this machine]. Avoid.
- Per-user task via Task Scheduler cmdlets works without admin [V: Register-ScheduledTask with `-AtLogOn -User` registered/unregistered from a non-elevated shell]. `schtasks /Create /XML` with LogonTrigger+UserId usually works too [U, not run].
- HKCU Run key works without admin [V]; Startup-folder shortcut also works. Both lack restart-on-failure; use as fallback.
- Exact commands (run via `powershell.exe -NoProfile -NonInteractive -Command`):
```powershell
$d = "$env:LOCALAPPDATA\wa-bridge\app\0.1.0"
$a = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$d\launch.vbs`"" -WorkingDirectory $d
$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "wa-bridge" -Action $a -Trigger $t -Settings $s -Force
Start-ScheduledTask -TaskName "wa-bridge"
```
- `launch.vbs` (hides console; style 0):
```vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & sh.CurrentDirectory & "\runtime\node.exe"" app\service.js", 0, False
```
- Why: node.exe is a console app, so Task Scheduler would show a console window in the interactive session. Alternatives: Node self-relaunch `spawn(process.execPath,[svc],{detached:true,windowsHide:true,stdio:'ignore'}).unref()` (brief flash from the stub); `powershell -WindowStyle Hidden` also flashes. WSH can be disabled by policy, so keep the self-relaunch fallback.
- Registry fallback: `reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v wa-bridge /t REG_SZ /d "wscript.exe //B //Nologo \"%LOCALAPPDATA%\wa-bridge\app\0.1.0\launch.vbs\"" /f` [V that Run-key add works].
- Single instance: service binds a fixed 127.0.0.1 port / named pipe `\\.\pipe\wa-bridge-<user>`; second start exits.
- Uninstall: `Unregister-ScheduledTask -TaskName wa-bridge -Confirm:$false`; `reg delete ...Run /v wa-bridge /f`.

## 5. Data location and keychain
- Use `%LOCALAPPDATA%\wa-bridge` for DB, WhatsApp creds, logs (machine-local; Roaming profiles shouldn't sync encrypted DBs). `%APPDATA%` only for tiny config.
- MSIX caveat [partially V]: Claude Desktop is MSIX; `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\{Local,Roaming}` contains redirected app data (e.g. `Roaming\Claude-NativeHost`). Processes with package identity (possibly the MCP server child) may have AppData writes virtualized, while the Task Scheduler service does not, so the two could see different physical `%APPDATA%\wa-bridge`. Mitigations: MCP process never touches data files, only IPC to the service; service passes any paths over IPC; for anything shared consider `%USERPROFILE%\.wa-bridge` (not virtualized). Test: write a marker from the MCP process into `%LOCALAPPDATA%\wa-bridge` and look from a normal shell [U].
- Keychain: `@napi-rs/keyring` -> Windows Credential Manager (per-user vault). A task registered for the current user with default Interactive logon type, running at logon in the user's session, can access it (same user, same vault) [Win32 semantics; module load verified, actual read in a scheduled task not exercised]. Gotchas: do NOT use "run whether user is logged on or not" (stores password, different logon session); use identical service/account strings in all processes (service is sole accessor); retry 3x with backoff on first read at logon; blob limit ~2.5 KB is fine for a key. Credential Manager is not file/registry-virtualized, so MSIX identity should not matter [U].

## 6. Update story
- Desktop replaces the extension dir and restarts MCP servers; it does not know about the service. Since the service runs from its own copy under LOCALAPPDATA, the old process keeps running and no loaded DLL/exe in the extension dir is overwritten.
- On each MCP start: IPC `GET /version`. Service missing -> install+start. Version mismatch -> stage `app\<newver>\` (copy runtime unless hash same), IPC `shutdown` (flush DB, close socket) and wait up to 10 s (then kill by pidfile), `Set-ScheduledTask`/`Register-ScheduledTask -Force` with new action path, `Start-ScheduledTask`, prune old versions beyond N-1.
- Versioned dirs avoid "file in use" on node.exe/.node files. WhatsApp session survives (creds on disk); restart costs seconds. Refuse downgrades past a DB schema migration.
- Uninstalling the extension leaves the service running: ship `wa-bridge uninstall` (task + Run key + optional data wipe) and document it.

## Manifest skeleton (manifest_version 0.3; this shape validated by mcpb 2.1.2)
```json
{
  "manifest_version": "0.3",
  "name": "wa-bridge",
  "display_name": "WA Bridge",
  "version": "0.1.0",
  "description": "Read-only local WhatsApp context for Claude.",
  "author": { "name": "..." },
  "compatibility": { "platforms": ["win32"], "runtimes": { "node": ">=20" } },
  "server": {
    "type": "node",
    "entry_point": "server/mcp.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/mcp.js"],
      "env": { "WA_BRIDGE_BUNDLE": "${__dirname}", "WA_BRIDGE_DATA": "${user_config.data_dir}" }
    }
  },
  "user_config": {
    "data_dir": { "type": "directory", "title": "Data folder", "description": "Optional override; default is fine.", "required": false }
  },
  "tools": [ { "name": "search_messages", "description": "..." } ]
}
```
Bundle layout: `manifest.json, icon.png, server/mcp.js, app/service.js (+cli), runtime/node.exe, node_modules/ (pruned win32-x64)`. Build: `npm ci --omit=dev` on Windows x64 -> prune script -> `npx mcpb pack . wa-bridge.mcpb`.

## Risks / unknowns
1. [Highest] What Desktop's `node` really is (real node.exe vs Electron-as-node), version, `process.execPath`: undocumented. Run the probe. Keep the MCP process free of native modules and 22-only APIs.
2. MSIX AppData virtualization splitting MCP-process vs service views of `%APPDATA%`/`%LOCALAPPDATA%` (Q5). Test; IPC-only design contains it.
3. Package size with node.exe (~35-45 MB): no documented cap, but untested in Desktop's installer.
4. AV/SmartScreen heuristics on node.exe copies, hidden wscript launcher, unsigned .node files; WSH may be disabled by policy (fallback: self-relaunch).
5. Task registration may be blocked by corporate policy; keep Run-key fallback.
6. Orphaned service after extension uninstall.
7. Keychain read from a real logon-triggered task not exercised (only module load verified).
8. Minimum Claude Desktop version supporting manifest 0.3/0.4 undocumented; set `compatibility.claude_desktop` after testing.

---
# Addendum (scope update): Claude Code targets (VS Code ext, desktop app Code tab, terminal CLI). claude.ai web out of scope.
Sources: code.claude.com docs (plugin manifest reference, plugin-marketplaces, setup), fetched 2026-10-22 [D].

## 7. One-step install for Claude Code: plugin vs `claude mcp add`
- A **plugin** is the right unit: one dir = skills + MCP server + hooks, namespaced, versioned, updatable, uninstallable. `claude mcp add` only registers the server; skills would be hand-copied into `~/.claude/skills`, with no update path. Plugin wins.
- Commands [D]: shell `claude plugin marketplace add <owner>/<repo>` (GitHub shorthand, git URL, or local path), then `claude plugin install wa-bridge@wa-bridge-market` (default scope user). In-session equivalents: `/plugin marketplace add <owner>/<repo>`, `/plugin install wa-bridge@wa-bridge-market` (opens a details panel where the user confirms). Apply with `/reload-plugins` or restart. Also: `claude plugin list`, `claude plugin validate ./dir`, `claude plugin marketplace remove`, uninstall deletes `${CLAUDE_PLUGIN_DATA}` unless `--keep-data`.
- "Just ask Claude": Claude can run the two shell commands through its Bash/PowerShell tool, so "install wa-bridge" can work after the user approves the permission prompt [U, not tested end to end]. The `/plugin` slash commands are user-typed, not model-callable. Practical path: README says "paste these two lines" or "tell Claude: run `claude plugin marketplace add ...` then `claude plugin install ...`". Fully silent install is not possible (consent prompts are by design). Admin-style pre-seeding via `extraKnownMarketplaces` + `enabledPlugins` in settings.json exists [D name only, not verified].
- Hosting: a git repo with `.claude-plugin/marketplace.json`. Plugin can sit in the same repo (`"source": "./plugins/wa-bridge"`) or come from `github`, `git-subdir`, `url`, `archive` (HTTPS zip, e.g. a GitHub Release asset), or `npm` sources [D]. Built binaries (node.exe, node_modules) make git sources heavy; prefer `archive` or a release branch.
- Plugin names starting with `claude-`/`anthropic-` are rejected; `wa-bridge` is fine.
- `${CLAUDE_PLUGIN_ROOT}` = installed version dir and CHANGES on update; `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/` persists [D]. Our data stays in `%LOCALAPPDATA%\wa-bridge` (shared by Desktop and Code).
- Plugin `userConfig` mirrors mcpb `user_config` (types, `sensitive`, `${user_config.KEY}` in MCP env/args) [D].

## 8. Runtime for Claude Code users
- The native installer (`irm https://claude.ai/install.ps1 | iex`, winget `Anthropic.ClaudeCode`) installs a native binary: "The installed claude binary does not itself invoke Node" [D]. Node 22+ is needed only for the npm install route. So **do not assume `node` on PATH** for CLI / VS Code / Code-tab users.
- The bundled `node.exe` approach (Q3b) serves both hosts: plugin `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}/runtime/node.exe`. The same service copy under `%LOCALAPPDATA%\wa-bridge\app\<ver>\` serves Desktop and Code; because the MCP side is a thin IPC client with a version check, both hosts can coexist (newest bundle wins). SEA stays unattractive.
- Paths are substituted with forward slashes on Windows [D]; exec of `node.exe` that way is fine.
- Also recommended for the Desktop manifest: `"command": "${__dirname}/runtime/node.exe"` instead of `"node"`, making the MCP process independent of Desktop's built-in Node (removes Risk 1, costs ~30 MB per bundle). Decide after the probe.

## 9. One build, two packages from one dist/
Yes. Docs say plugin `mcpServers` can also point at a `.mcpb`/`.dxt` (extracted into `.mcpb-cache/`) [D, untested], but the simpler route is a shared payload with two thin wrappers:
```
build/payload/   (made once from dist/, esbuild-bundled; .node files external)
  server/mcp.js  app/service.js  app/cli.js
  node_modules/  (pruned win32-x64: better-sqlite3-mc prebuilds/win32-x64.node, @napi-rs/keyring + keyring-win32-x64-msvc)
  runtime/node.exe  LICENSE-node
build/mcpb/    = payload + manifest.json + icon.png     -> npx mcpb pack build/mcpb wa-bridge.mcpb
build/plugin/  = payload + plugin files:
  .claude-plugin/plugin.json
  .mcp.json
  skills/wa-bridge/SKILL.md       (project skills copied in)
  hooks/hooks.json                (optional SessionStart ensure-service)
```
`.claude-plugin/plugin.json`:
```json
{ "name": "wa-bridge", "displayName": "WA Bridge", "version": "0.1.0",
  "description": "Read-only local WhatsApp context for Claude.",
  "author": { "name": "..." }, "license": "...", "repository": "https://github.com/OWNER/wa-bridge" }
```
`.mcp.json` (auto-loaded from plugin root [D]):
```json
{ "mcpServers": { "wa-bridge": {
    "command": "${CLAUDE_PLUGIN_ROOT}/runtime/node.exe",
    "args": ["${CLAUDE_PLUGIN_ROOT}/server/mcp.js"],
    "env": { "WA_BRIDGE_BUNDLE": "${CLAUDE_PLUGIN_ROOT}" } } } }
```
`hooks/hooks.json` (optional; wrapper key required in hook files [D]):
```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
  "command": "\"${CLAUDE_PLUGIN_ROOT}/runtime/node.exe\" \"${CLAUDE_PLUGIN_ROOT}/app/cli.js\" ensure-service" } ] } ] } }
```
Marketplace repo `.claude-plugin/marketplace.json` (entry name must equal plugin.json name):
```json
{ "name": "wa-bridge-market", "owner": { "name": "..." },
  "plugins": [ { "name": "wa-bridge", "source": "./plugins/wa-bridge",
                 "description": "Read-only local WhatsApp context for Claude." } ] }
```
Notes: skills are auto-discovered from `skills/<name>/SKILL.md`; mcpb manifest has no skills field (top-level keys list has `tools`, `prompts` only) [V schema], so Desktop gets tools (and optional manifest `prompts`) but not SKILL.md files. Both `${__dirname}` and `${CLAUDE_PLUGIN_ROOT}` change per version, so the LOCALAPPDATA service copy is mandatory for both. Validate with `npx mcpb pack` and `claude plugin validate build/plugin`.

## Additional risks (Claude Code)
- ~40 MB binaries in git: use `archive` (Release zip) or `npm` source; untested.
- `claude plugin ...` not run end to end here; VS Code ext / Desktop Code tab documented to share `~/.claude/` [D], so the plugin should be visible in all, but verify.
- First-use approval of plugin MCP servers and `hooks` consent behavior [U].
- Plugin `version` pins: bump every release or users never receive updates [D].
