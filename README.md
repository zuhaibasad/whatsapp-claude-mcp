<div align="center">

<img src="docs/assets/hero.svg" alt="wa-bridge: your WhatsApp, briefed by Claude" width="100%">

# wa-bridge: WhatsApp summary and mentions for Claude Desktop (MCP server)

**A read-only, local MCP server that lets Claude brief you on the WhatsApp chats you choose.**<br>
Daily WhatsApp brief, mentions, follow-ups. Roman Urdu and English. Encrypted on your PC.

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Claude Desktop](https://img.shields.io/badge/Claude-Desktop%20%2B%20Code-D97757)
![MCP](https://img.shields.io/badge/MCP-server-8A63D2)
![Read-only](https://img.shields.io/badge/WhatsApp-read--only-brightgreen)

</div>

> [!NOTE]
> Independent open-source project. Not affiliated with or endorsed by WhatsApp, Meta, or Anthropic.

## What it does

- 📋 **Daily brief.** Ask "Give me my WhatsApp brief". Get Critical, Mentions, By department and FYI.
- 🔎 **Search and follow-ups.** Find old messages. Save action items. Export them to CSV or JSON.
- 🛡️ **Read-only and private.** Never sends. Never marks read. Data stays on your PC, encrypted.

<div align="center">
<img src="docs/assets/brief.svg" alt="Example WhatsApp brief shown in a Claude chat. Fake data." width="760">
<br><sub>Example with fake data. Claude writes the summary. wa-bridge only supplies the messages.</sub>
</div>

## How setup looks

Setup runs inside the Claude chat (or in your browser for Claude Code). Four steps, about two minutes.

<table>
<tr>
<td align="center" width="25%"><b>1. Accept</b></td>
<td align="center" width="25%"><b>2. Scan QR</b></td>
<td align="center" width="25%"><b>3. Choose chats</b></td>
<td align="center" width="25%"><b>4. Ask Claude</b></td>
</tr>
<tr>
<td><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/setup-needs_accept-light.png"><img src="docs/assets/setup-needs_accept-dark.png" alt="Risk notice screen"></picture></td>
<td><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/setup-linking-light.png"><img src="docs/assets/setup-linking-dark.png" alt="QR code screen"></picture></td>
<td><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/setup-choose_chats-light.png"><img src="docs/assets/setup-choose_chats-dark.png" alt="Chat picker with search and tabs"></picture></td>
<td><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/setup-done-light.png"><img src="docs/assets/setup-done-dark.png" alt="Done screen"></picture></td>
</tr>
<tr>
<td>Read the risks. Tick the box.</td>
<td>Phone: Linked devices, then Link a device.</td>
<td>Search by name or number. Groups, direct chats, channels.</td>
<td>Say: "Give me my WhatsApp brief".</td>
</tr>
</table>

<sub>Screenshots use mock data.</sub>

## Install in 2 minutes (Claude Desktop, Windows)

1. Get `wa-bridge-<version>.mcpb` from the [Releases](../../releases) page. No release yet? Build it: `npm ci` then `npm run build:mcpb` (the file appears in `build/`).
2. Claude Desktop: **Settings, Extensions, Advanced settings, Install Extension**. Pick the file. Enable **WhatsApp Bridge (read-only)**.
3. In a chat, say **"Set up WhatsApp"** and follow the four steps above.

Tools missing? Quit Claude Desktop fully and open it again. You need Windows, your own phone with WhatsApp, and a Claude account.

<details>
<summary><b>Claude Code (from source)</b></summary>

```powershell
git clone https://github.com/zuhaibasad/whatsapp-claude-mcp.git
cd whatsapp-claude-mcp
npm ci
npm run build
claude mcp add --transport stdio --scope user wa-bridge -- "$((Get-Command node).Source)" "$((Resolve-Path dist/mcp/main.js).Path)"
```

Needs Node.js 22.12 or newer. In Claude Code run `/mcp` to check, then say "Set up WhatsApp". Setup opens in your browser. Optional skills for briefs, mentions, reports and export are in [`skills/`](skills/README.md).
</details>

## Things to ask Claude

| Ask | You get |
|---|---|
| "Give me my WhatsApp brief" | Critical, Mentions, By department, FYI |
| "Who mentioned me since my last review?" | Mentions and replies, with suggested text to copy |
| "Search ERP Support for invoice issues, last 7 days" | Matching messages with sender and time |
| "Save this as a high-priority Finance follow-up" | A local action item |
| "Show my open items by department" | Your follow-up list, oldest first |
| "Stop reading the Family group" | Chat selection updated |

## How it works

```mermaid
flowchart LR
    WA([WhatsApp]) <-->|linked device, read-only| C
    subgraph PC[Your Windows PC]
        direction LR
        subgraph M[wa-bridge MCP server]
            C[Collector] --> T[7 MCP tools]
        end
        C --> S[(Encrypted local store)]
        K[OS keychain] -.keys.-> S
        S --> T
    end
    T <-->|only what Claude reads| CL[Claude Desktop / Code]
    CL -.->|model processing| AN[(Anthropic)]
```

The collector lives inside the MCP server, so it runs only while Claude is open. There is no cloud relay and no public endpoint.

## Private by design

- 🏠 **Local only.** Messages are stored in `%USERPROFILE%\.wa-bridge`. The setup page listens on `127.0.0.1` only.
- 🔐 **Encrypted.** The message database and the WhatsApp session are encrypted. The key is in Windows Credential Manager, never in a file.
- 👀 **Read-only.** No sending, no blue ticks, no "online" status. Code checks in the test suite block write APIs.
- ✅ **You choose the chats.** Excluded chats are not stored. Direct chats and channels start off. Messages expire after 30 days by default.
- 🧱 **Untrusted content.** Setup secrets (QR, tokens) never enter Claude's tool results. Chat text is data, not instructions. Prompt injection is a known risk, so review any export request.

> [!WARNING]
> **Know the risks before you connect.**
> - This is an **unofficial linked device**. It is against WhatsApp's Terms of Service. Your number could be restricted or banned.
> - **Other people in your chats did not agree** to an AI reading their messages. Think before you add work or family groups.
> - **Text that Claude reads is sent to Anthropic.** Local storage does not mean local AI.
> - Connect only your own account.

## FAQ

<details><summary>Does it send messages?</summary>
<br>No. Claude can draft a reply, and you copy and send it yourself. The only write call to WhatsApp is the logout used to disconnect.
</details>

<details><summary>Where is my data stored?</summary>
<br>On your PC in <code>%USERPROFILE%\.wa-bridge</code>: <code>store.db</code> and <code>auth.db</code> (encrypted), plus plain config files and exports. Exports and YAML files are not encrypted, so protect them.
</details>

<details><summary>What if Claude is closed?</summary>
<br>Nothing is collected while Claude is closed. When you open it again, wa-bridge catches up on what WhatsApp still provides. Long gaps can leave holes.
</details>

<details><summary>Why not claude.ai in the browser?</summary>
<br>claude.ai connectors run from Anthropic's cloud and cannot reach a program on your PC. Supporting it would mean a tunnel or relay that exposes your chats to the internet. This project chooses not to.
</details>

<details><summary>How many tokens does it use?</summary>
<br>A brief is one tool call with capped text sizes. Messages Claude reads count toward your normal Claude usage. Choose fewer chats to use less.
</details>

<details><summary>How do I disconnect?</summary>
<br>On your phone: WhatsApp, Linked devices, remove the wa-bridge device. Delete <code>%USERPROFILE%\.wa-bridge</code> to remove local data. This does not recall text already sent to Claude.
</details>

## Roadmap

Voice-note transcription (local), missed-call items, macOS and Linux. See [docs/ROADMAP.md](docs/ROADMAP.md). Not built yet.

<details>
<summary><b>Contributing and development</b></summary>

```powershell
npm ci
npm run check      # lint, typecheck, tests
npm run build
npm run build:mcpb # Claude Desktop bundle
```

Read [docs/PLAN.md](docs/PLAN.md), [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/notes/](docs/notes/). Keep the read-only rule. Use fake fixtures. Never commit a real `.wa-bridge` folder, QR, session or export.

Seven MCP tools: `whatsapp_brief`, `whatsapp_status`, `whatsapp_read`, `whatsapp_items`, `whatsapp_mark_reviewed`, `whatsapp_setup`, `whatsapp_choose_chats`.
</details>

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). Dependencies keep their own licenses. A license review is in [docs/LICENSE_OPTIONS.md](docs/LICENSE_OPTIONS.md).

## Disclaimer

wa-bridge is an independent project. It is not affiliated with, authorized by, or endorsed by WhatsApp LLC, Meta Platforms, or Anthropic. WhatsApp, Meta and Claude are trademarks of their owners, used here only to describe compatibility. Use at your own risk and follow the laws and terms that apply to you.

<div align="center"><sub>Built by <a href="https://github.com/zuhaibasad">Zuhaib Asad</a></sub></div>
