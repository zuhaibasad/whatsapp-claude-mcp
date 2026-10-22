# GitHub search visibility (SEO)

## Repo name
Decided (2026-10-22): keep **`whatsapp-claude-mcp`**. The product is branded **ChatAI for WhatsApp** (CLI and `.mcpb` file: `chatai`); the repo name stays keyword-rich.
Avoid putting "Claude" or "WhatsApp" first in the name: it can imply an official product. Keep the keywords in the description and topics instead. Renaming keeps old links working (GitHub redirects), but update the clone URL in README.md after renaming.

## Description (max 350 chars; this one is 216)
> Read-only, local MCP server that gives Claude Desktop and Claude Code a daily WhatsApp brief: mentions, urgent items and follow-ups from the chats you choose. Roman Urdu and English. Encrypted on your PC. Unofficial.

## Topics (20)
`whatsapp` `claude` `claude-desktop` `claude-code` `mcp` `mcp-server` `model-context-protocol` `mcpb` `anthropic` `baileys` `whatsapp-summary` `whatsapp-ai` `ai-assistant` `productivity` `daily-brief` `local-first` `privacy` `sqlcipher` `typescript` `windows`

Also set: Website = the latest release page.

## Social preview
Upload `docs/assets/social-preview.png` (1280x640, under 1 MB) in Settings, General, Social preview. Source: `docs/assets/social.svg`. It shows the name, tagline and "Read-only, Encrypted, Local".

## Keyword placement
- **First 160 characters of README** (shown in search snippets): the H1 and bold line already contain "WhatsApp", "Claude Desktop", "MCP server", "read-only", "brief". Keep them there.
- **Headings:** use plain search phrases ("Install in 2 minutes", "Things to ask Claude", "Private by design", "FAQ"). Do not stuff.
- **Image alt text:** descriptive (done for all images). GitHub indexes it.
- Mention the exact phrases people search: "WhatsApp MCP", "WhatsApp summary Claude", "Claude Desktop extension (.mcpb)".
- Link to the repo from other places you control (profile README, blog post, MCP directories such as the official MCP servers list and awesome-mcp lists). Inbound links and stars matter more than keywords.
- Do not buy stars or use fake metrics.

## Releases
- Tag: `v0.2.0` (semver). Release title: **`ChatAI for WhatsApp v0.3.0: briefs and bills for Claude Desktop`**.
- Attach `chatai-0.3.0.mcpb` (Windows x64) and its SHA-256 in the notes.
- Notes in 3 parts: What is new (3 bullets), Install (2 lines), Known limits (Windows only, unofficial, ban risk).
- If the bundle includes a GPL-3.0 transitive dependency, say so in the notes. See `docs/LICENSE_OPTIONS.md`.
