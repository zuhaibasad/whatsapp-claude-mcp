# License options for wa-bridge

> **Update 2026-10-22:** the project switched to **MIT** (see DECISIONS). The Apache-2.0 recommendation below is kept as history. The GPL-3.0 libsignal question for public bundles is unchanged.

Status: review only. `LICENSE` and `NOTICE` were not changed. This is engineering analysis, not legal advice. Get a lawyer's review before you sell anything or publish a bundle.

## 1. Facts that drive the choice

- **Use now:** personal and friends. **Later:** possibly paid "premium" features (voice-note transcription, call items, other ideas in `docs/ROADMAP.md`). The README premium section was removed in this rewrite, because it promised items that do not exist.
- **WhatsApp context:** the bridge is an unofficial client (Baileys). No license can fix WhatsApp's Terms of Service. Commercial resale raises the risk (WhatsApp is more likely to act against a commercial product). No license grants trademark rights either.
- **Dependency licenses** (checked with `npm view <pkg> license`, and in `node_modules`):

| Package | License |
|---|---|
| baileys 7.0.0-rc14 | MIT |
| better-sqlite3-multiple-ciphers | MIT |
| @napi-rs/keyring | MIT |
| @modelcontextprotocol/server | **Apache-2.0** |
| @modelcontextprotocol/ext-apps | MIT |
| https-proxy-agent, qrcode, pino, zod, commander, @inquirer/core | MIT |
| yaml | ISC |
| Transitive, from Baileys: whatsapp-rust-bridge, music-metadata, ws | MIT |
| Transitive: protobufjs | BSD-3-Clause |
| **Transitive, from Baileys: `libsignal` 6.0.0 (WhiskeySockets/libsignal-node)** | **GPL-3.0** |

## 2. Important finding: a GPL-3.0 dependency

`baileys` depends on `libsignal` (GPL-3.0). The Baileys package itself says MIT, but the installed tree contains GPL-3.0 code, and `build:mcpb` copies production `node_modules` into the `.mcpb`.

- **Running from source for yourself:** no distribution, no obligation.
- **Giving a `.mcpb` to friends or publishing it:** this is distribution. GPL-3.0 then asks that the combined work be offered under GPL-3.0 terms, with source. Apache-2.0 code can be combined into a GPL-3.0 work (one direction only), so Apache-2.0 for your own code is not blocked. But the *whole bundle* is effectively GPL-3.0, and Apache-2.0 alone would be an incomplete description of it.
- **Why it matters for premium:** a closed-source premium module that links into the same process and is distributed together with `libsignal` is a risk. Whether dynamic `require()` makes a "combined work" is a legal question I cannot settle here.
- **Not verified:** I did not read the Baileys source to check how `libsignal` is loaded, and I am not a lawyer. Treat this as a flag to resolve before the first public release.
- **Options:** (a) accept GPL-3.0 obligations for the distributed bundle and ship source; (b) keep the bundle personal and let others build from source; (c) ask a lawyer whether the Baileys/libsignal combination can be structured differently; (d) watch whether Baileys moves off `libsignal` (the `whatsapp-rust-bridge` dependency suggests a move may be coming).

## 3. Options compared

| Option | Open source? | Personal/friends | Paid premium later | Pros | Cons |
|---|---|---|---|---|---|
| **Apache-2.0** (current) | Yes | Yes | Yes: premium can be a separate closed module | Permissive, patent grant, matches MCP SDK license, trusted, easy to adopt | Anyone (including a competitor) can resell or host it. Patent grant does not stop that |
| **MIT** | Yes | Yes | Yes | Shortest, most familiar, matches most deps | No patent grant, no explicit trademark clause. No benefit over Apache here |
| **AGPL-3.0** | Yes | Yes | Yes via dual licensing (you sell a commercial license) | Blocks closed hosted forks. Aligns with the GPL-3.0 libsignal | Many companies ban AGPL, so fewer contributors. Dual licensing needs a CLA from every contributor |
| **BSL 1.1** | No (source-available) | Yes | Yes: restricts production use of competing offers until a change date | Protects the premium business for a few years. Converts to open source later | Not OSI open source. Cannot be combined cleanly with GPL-3.0 libsignal. Unfamiliar to users |
| **Elastic License 2.0** | No | Yes | Yes: forbids offering it as a managed service | Simple. Targets hosted competitors only | Not open source. Same GPL-3.0 conflict. Fewer contributors |
| **PolyForm Noncommercial** | No | Yes | Yes: commercial use needs a paid license | Clear: free for personal use, paid for business | Blocks businesses from even trying it. Not open source. Same GPL-3.0 conflict |
| **PolyForm Shield** | No | Yes | Yes: forbids competing products | Allows internal commercial use | Not open source. Same GPL-3.0 conflict |

## 4. Recommendation

1. **Keep Apache-2.0 for the core.** It is the best fit for the project today: open, permissive, patent grant, compatible with the dependencies including the GPL-3.0 one (the bundle just needs GPL-3.0 compliance, see section 2). Do not move to a source-available license while the bundle contains GPL-3.0 code, because the licenses would conflict.
2. **Put premium features in a separate repo or package under a commercial license.** Core stays read-only. Premium (for example local voice-note transcription) is a separate module that talks to the core through a documented interface, not linked into the same bundle. This keeps the open core clean and gives you a clear line for pricing. Ask a lawyer to confirm the separation given `libsignal`.
3. **Resolve the `libsignal` GPL-3.0 question before publishing a `.mcpb` publicly.** Until then, share the bundle only with friends who accept it, or let people build from source. Add a clear note in release notes.
4. **Rename the legal name in `NOTICE`.** See section 5. Do not use a name that starts with "WhatsApp" or "Claude".
5. Add a short `CONTRIBUTING` note (or DCO sign-off) now. If you ever dual-license or relicense, you will need the right to do so for outside contributions.

## 5. NOTICE review

Current `NOTICE`:

```
WhatsApp Claude MCP (wa-bridge)
Copyright 2026 Zuhaib Asad
Licensed under the Apache License, Version 2.0.
Third-party dependencies retain their respective copyrights and licenses.
```

- **Accurate:** the copyright holder and license match `LICENSE` and `package.json` (`Apache-2.0`).
- **Fix the product name:** "WhatsApp Claude MCP" uses two third-party trademarks as a product name. Use "wa-bridge" (the README and manifest already do).
- **Too thin for a bundle.** A `NOTICE` under Apache-2.0 is for attribution notices; it is not a place for dependency license texts. For the `.mcpb`, ship these as well:
  - **MIT, ISC, BSD-3-Clause deps:** each must keep its copyright notice and license text. `build-mcpb.mjs` keeps the `LICENSE` files inside `node_modules` (comment in the script says so). Check that the built `.mcpb` really contains them for every package (not verified here). A generated `THIRD_PARTY_LICENSES.txt` (for example from `license-checker`) is safer and easier for users to read.
  - **Apache-2.0 deps** (`@modelcontextprotocol/server`): keep its `LICENSE`. If it ever ships a `NOTICE` file, its contents must be reproduced. The installed version has none.
  - **GPL-3.0 dep (`libsignal`):** include its license text and a written offer or link to its source (https://github.com/WhiskeySockets/libsignal-node), and say which version is bundled.
  - **Trademark line:** add "WhatsApp is a trademark of WhatsApp LLC. Claude is a trademark of Anthropic. This project is not affiliated with them."
- Suggested new first line: `wa-bridge`, then the existing copyright and license lines.
