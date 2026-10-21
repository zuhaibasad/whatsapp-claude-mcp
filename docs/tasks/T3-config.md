# T3 — Config files (YAML) + chat filter

**Model tier:** Haiku · **Depends on:** nothing · **Owned files:** `src/config/**`, `templates/**`, `test/config/**`

Contracts: `Config`, `Department`, `PriorityRules` in `src/core/contracts.ts`. Paths in `src/core/paths.ts`. Read PLAN §5 (filtering) and the brief summary below.

## Deliverables
1. `templates/config.yaml`: commented, human-friendly YAML with snake_case keys:
   `retention_days: 30`, `timezone: ""` (empty = system), `include_groups: true`, `include_direct_chats: false`, `allowlist: []`, `denylist: []`, `my_names: []` (comment: "Your names and nicknames, e.g. Zuhaib, Zuhaib bhai, ZA, for mention detection in text"), `max_text_chars: 2000`, `log_level: info`. Comments explain each key in plain English, and that allowlist/denylist accept a chat name or chat id, and that the denylist wins.
2. `templates/departments.yaml`: a list of `{name, keywords[], examples[]}` for ERP, IT, Finance, Sales and Ops. Use 3–5 keywords and 2 example messages each. Include **Roman Urdu + English mixed** examples (e.g. "ERP mein invoice post nahi ho raha, urgent check karein"). Add a top comment: "Guidance for Claude, not strict rules".
3. `templates/priorities.yaml`: `critical`, `high` and `low` lists of plain descriptions (critical: system down, payment/money issue, client complaint, deadline today, security incident). Add mixed-language examples.
4. `src/config/load.ts`
   - zod (v4) schemas for the 3 files. Map snake_case to the camelCase `Config`. Fill in defaults for missing keys. Unknown keys produce a warning, not an error. Empty `timezone` becomes `Intl.DateTimeFormat().resolvedOptions().timeZone`. Validate the IANA zone (fall back to system zone + warning).
   - `loadConfig(paths: DataPaths): { config: Config; warnings: string[] }`. A missing file gives defaults + a warning. Invalid YAML or values throw `ConfigError` with the file path and a readable message.
   - `loadDepartments(paths): Department[]`, `loadPriorities(paths): PriorityRules` work the same way.
   - `writeDefaultConfigs(paths, { overwrite = false } = {}): string[]` copies the templates into `paths.dataDir` (create the dir), skips existing files unless overwrite is set, and returns the written paths. Locate `templates/` relative to the package root via `import.meta.url` (it works from `src/` under vitest and from `dist/` after build; walk up until a `templates` folder is found).
5. `src/config/filter.ts`: `isChatIncluded(cfg: Config, chat: { id: string; name: string | null; type: ChatType }): boolean`
   - The denylist match (id exact, or name case-insensitive trimmed) gives false.
   - Else the allowlist match gives true.
   - Else type default: group → `includeGroups`, direct → `includeDirectChats`.
6. `src/config/index.ts` re-exports.

## Tests (`test/config/`)
Defaults when files are missing. The snake→camel mapping. Invalid values (e.g. retention_days: -1, a string) throw ConfigError naming the file. Unknown key produces a warning. Bad timezone produces a fallback + warning. writeDefaultConfigs does not overwrite. The templates themselves parse without warnings. Filter precedence table test (deny > allow > type default, name case-insensitive).

## Acceptance
`npm run check` passes. Write `.agents/notes/T3.md` with the public API.
