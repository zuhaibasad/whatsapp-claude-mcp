# T1 — Read-only guard tests (layers 2 + 3 scaffolding)

**Model tier:** Sonnet · **Depends on:** nothing · **Owned files:** `test/guard/**`, `scripts/guard-list.ts` (optional)

## Goal
The build must fail if any code in `src/` uses a WhatsApp write API. See PLAN §7. ESLint layer 1 already exists (`eslint.config.js`).

## Deliverables
1. `test/guard/denylist.ts` exports `WRITE_API_DENYLIST: readonly string[]` with **exactly** the names in PLAN §7, plus the group-prefix patterns as regexes (`/^groupUpdate/`, `/^groupInvite/`, `/^groupAcceptInvite/`, `/^groupRevokeInvite/`, `/^updateProfile/`, `/^update\w*Privacy$/`, `/^addLabel/`, `/^removeLabel/`, `/^newsletter/`). Also export `ALLOWED_EXCEPTIONS = ['logout']`. That one is allowed **only** inside a function named `unlink` in `src/daemon/wa/wa-client.ts`.
2. `test/guard/readonly.test.ts` uses the **TypeScript compiler API** (`import ts from 'typescript'`) to parse every `.ts` file under `src/` and fail with a clear message (`file:line  name`) when it finds:
   - a property access or identifier matching the denylist (e.g. `sock.sendMessage`, `const { readMessages } = sock`, a string-literal element access `sock['sendMessage']`)
   - a computed element access with a non-literal key on any identifier named `sock`/`socket` (`sock[x]`)
   - `logout` used anywhere except inside `function unlink` / method `unlink` in `src/daemon/wa/wa-client.ts`
   - a `baileys` import outside `src/daemon/wa/**` (belt-and-braces with ESLint)
   - an import of `downloadMediaMessage` anywhere
3. **Self-test fixtures:** `test/guard/fixtures/bad/*.ts.txt` (one per rule) and `good/*.ts.txt`. Use the `.txt` suffix so tsc/eslint ignore them. Export the scanner as a function `scanSource(fileName, sourceText): Violation[]` from `test/guard/scanner.ts`, and test it against the fixtures. That proves the guard catches each case and does not false-positive on `logout` inside `unlink`.
4. `test/guard/baileys-api-coverage.test.ts` imports `baileys` (allowed in tests) and checks **drift**. Collect the keys of the socket type's write-ish methods by reading `node_modules/baileys/lib/Socket/*.d.ts` and matching names that start with `send|update|group|chatModify|star|read|presence|reject|offer|add|remove|newsletter|relay|appPatch|resync|request|fetchMessageHistory`. Assert every one is either in the denylist (or matched by a pattern) or listed in an explicit `REVIEWED_SAFE` array in that test, with a one-line reason each. Examples: `requestPairingCode` is not used by us; `groupMetadata` and `groupFetchAllParticipating` are reads and **allowed**. Read-only fetches are fine: `groupMetadata`, `groupFetchAllParticipating`, `profilePictureUrl` (but not used), `onWhatsApp`, `fetchStatus`. When a Baileys upgrade adds a new write method, this test fails until someone reviews it.

Current `src/` has no WhatsApp code yet. The scan must pass on it, and the fixtures prove it works.

## Acceptance
- `npm run check` passes.
- Every bad fixture yields ≥1 violation with the right rule id. Good fixtures yield 0.
- Clear failure output that names the file and line.
