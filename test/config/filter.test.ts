import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/contracts.js';
import { isChatIncluded, type FilterChat } from '../../src/config/index.js';

function cfg(over: Partial<Config> = {}): Config {
  return {
    retentionDays: 30,
    timezone: 'UTC',
    includeGroups: true,
    includeDirectChats: false,
    allowlist: [],
    denylist: [],
    myNames: [],
    maxTextChars: 2000,
    logLevel: 'info',
    ...over,
  };
}

const group: FilterChat = { id: '1203@g.us', name: 'Project Team', type: 'group' };
const direct: FilterChat = { id: '92300@s.whatsapp.net', name: 'Ali Khan', type: 'direct' };

describe('isChatIncluded precedence', () => {
  const cases: { label: string; config: Partial<Config>; chat: FilterChat; expected: boolean }[] = [
    { label: 'group with default settings', config: {}, chat: group, expected: true },
    { label: 'direct with default settings', config: {}, chat: direct, expected: false },
    { label: 'groups switched off', config: { includeGroups: false }, chat: group, expected: false },
    { label: 'direct switched on', config: { includeDirectChats: true }, chat: direct, expected: true },
    { label: 'allowlist by id beats type default', config: { allowlist: ['92300@s.whatsapp.net'] }, chat: direct, expected: true },
    { label: 'allowlist by name beats type default', config: { includeGroups: false, allowlist: ['Project Team'] }, chat: group, expected: true },
    { label: 'allowlist name is case-insensitive', config: { includeGroups: false, allowlist: ['  project TEAM  '] }, chat: group, expected: true },
    { label: 'denylist by id beats type default', config: { denylist: ['1203@g.us'] }, chat: group, expected: false },
    { label: 'denylist by name is case-insensitive', config: { denylist: ['ali khan'] }, chat: { ...direct, type: 'direct' }, expected: false },
    { label: 'denylist beats allowlist (by id)', config: { allowlist: ['1203@g.us'], denylist: ['1203@g.us'] }, chat: group, expected: false },
    { label: 'denylist beats allowlist (by name)', config: { allowlist: ['Project Team'], denylist: ['project team'] }, chat: group, expected: false },
    { label: 'denylist beats allowlist on a direct chat', config: { includeDirectChats: true, allowlist: ['Ali Khan'], denylist: ['Ali Khan'] }, chat: direct, expected: false },
    { label: 'id match is exact, not case-insensitive', config: { denylist: ['1203@G.US'] }, chat: group, expected: true },
    { label: 'name-less chat ignores name entries', config: { includeDirectChats: true, denylist: ['Ali Khan'] }, chat: { id: 'x@lid', name: null, type: 'direct' }, expected: true },
    { label: 'empty entries match nothing', config: { denylist: ['   '] }, chat: { id: 'x', name: '', type: 'group' }, expected: true },
  ];

  it.each(cases)('$label', ({ config, chat, expected }) => {
    expect(isChatIncluded(cfg(config), chat)).toBe(expected);
  });
});
