import type { Config } from '../core/contracts.js';
import type { ChatType } from '../core/types.js';

export interface FilterChat {
  id: string;
  name: string | null;
  type: ChatType;
}

/** An entry matches by exact id, or by name (trimmed, case-insensitive). */
function matchesEntry(entry: string, chat: FilterChat): boolean {
  const e = entry.trim();
  if (e === '') return false;
  if (e === chat.id) return true;
  const name = chat.name?.trim().toLowerCase();
  return name !== undefined && name !== '' && e.toLowerCase() === name;
}

/**
 * Precedence: denylist (false) > allowlist (true) > type default
 * (group -> includeGroups, direct -> includeDirectChats).
 */
export function isChatIncluded(cfg: Config, chat: FilterChat): boolean {
  if (cfg.denylist.some((entry) => matchesEntry(entry, chat))) return false;
  if (cfg.allowlist.some((entry) => matchesEntry(entry, chat))) return true;
  return chat.type === 'group' ? cfg.includeGroups : cfg.includeDirectChats;
}
