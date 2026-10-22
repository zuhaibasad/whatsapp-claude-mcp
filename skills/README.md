# chatai skills

Five Claude skills that drive the `chatai` MCP server (tools appear as `mcp__chatai__<tool>`: `whatsapp_brief`, `whatsapp_status`, `whatsapp_read`, `whatsapp_items`, `whatsapp_mark_reviewed`, `whatsapp_setup`, `whatsapp_choose_chats`). All are read-only toward WhatsApp.

| Skill | Use |
| --- | --- |
| `wa-daily-brief` | Brief of new messages: Critical / Mentions / By department / FYI |
| `wa-mentions` | Mentions with suggested replies (for you to copy) |
| `wa-department-report` | Open items by department, with stale flags |
| `wa-export` | Export items to CSV/JSON, optionally to Sheets/Notion |
| `wa-setup` | Guided install and linking |

## Installing

Copy the folders into your project's `.claude/skills/` (or `~/.claude/skills/` for all projects):

```
cp -r skills/wa-* .claude/skills/
```

On Windows PowerShell: `Copy-Item -Recurse skills\wa-* .claude\skills\`. Restart Claude Code, then ask e.g. "give me my WhatsApp brief". The MCP server must be registered (`chatai mcp`, server name `chatai`); `wa-setup` walks through everything.

The skills read `.chatai/departments.yaml` and `priorities.yaml` as guidance, so tune those rather than editing the skills.
