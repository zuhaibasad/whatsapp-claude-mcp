#!/usr/bin/env bash
# Injects the vault handoff + lean-session reminder into every new Claude session.
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
echo "=== wa-bridge: SESSION START ==="
echo "Follow CLAUDE.md (token-lean). Vault = docs/. Do not read big docs in full; open sections as needed."
echo
if [ -f "$ROOT/docs/00-System/HANDOFF.md" ]; then
  echo "--- docs/00-System/HANDOFF.md ---"
  cat "$ROOT/docs/00-System/HANDOFF.md"
fi
echo
echo "--- git worktrees ---"
git -C "$ROOT" worktree list 2>/dev/null
echo
echo "--- git status ---"
git -C "$ROOT" status --short 2>/dev/null | head -20
exit 0
