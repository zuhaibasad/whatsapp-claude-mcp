// Drift detector: when a Baileys upgrade adds a new write-ish socket method, this test fails until
// someone reviews it (add to the denylist, or to REVIEWED_SAFE below with a reason).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as baileys from 'baileys';
import { describe, expect, it } from 'vitest';
import { ALLOWED_EXCEPTIONS, WRITE_API_DENYLIST, isWriteApi } from './denylist.js';

const SOCKET_DIR = path.resolve(import.meta.dirname, '..', '..', 'node_modules', 'baileys', 'lib', 'Socket');

/** Names that look write-ish (by prefix) and are matched for review. */
const WRITEISH =
  /^(send|update|group|chatModify|star|read|presence|reject|offer|add|remove|newsletter|relay|appPatch|resync|request|fetchMessageHistory|community|product|create|upload|rotate|subscribe|issue|query|logout|refresh|digest|assert|clean|execute|wa[A-Z])/;

/**
 * Write-ish names that were reviewed and are NOT write APIs we call. Each needs a reason.
 * Being listed here does not make a name legal to use if it is also in the denylist.
 */
export const REVIEWED_SAFE: Readonly<Record<string, string>> = {
  groupMetadata: 'read: fetch one group metadata',
  groupFetchAllParticipating: 'read: list groups we are in',
  groupGetInviteInfo: 'read: look up an invite code; not used by us',
  groupRequestParticipantsList: 'read: list pending join requests; not used by us',
  communityMetadata: 'read: community metadata; not used by us',
  communityFetchAllParticipating: 'read: list communities; not used by us',
  communityFetchLinkedGroups: 'read: linked groups of a community; not used by us',
  communityGetInviteInfo: 'read: invite info lookup; not used by us',
  communityRequestParticipantsList: 'read: pending requests list; not used by us',
  requestPairingCode: 'pairing handshake (phone-number linking); not used, we link by QR',
  query: 'generic request/response helper; reachable only through the socket, which the wa-client facade never exposes. Too generic a name to ban in the scanner',
  assertSessions: 'signal session setup for decryption/retry; internal',
  digestKeyBundle: 'signal key-bundle check; internal housekeeping',
  cleanDirtyBits: 'clears server-side dirty flags after sync; internal housekeeping, not a message action',
  refreshMediaConn: 'refresh media host connection info; media is never downloaded',
  createParticipantNodes: 'builds local encrypted-node structures for message sending; sends nothing itself',
  updateServerTimeOffset: 'local clock-offset bookkeeping; sends nothing',
  executeUSyncQuery: 'user-sync query (read); not used by us',
  waitForMessage: 'local wait helper, sends nothing',
  waitForConnectionUpdate: 'local wait helper, sends nothing',
  waitForSocketOpen: 'local wait helper, sends nothing',
};

function typeLiteralMembers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    // declare const makeXxxSocket: (config) => { member: ...; ... }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^make\w*Socket$/.test(n.name.text)) {
      const t = n.type;
      if (t && ts.isFunctionTypeNode(t) && ts.isTypeLiteralNode(t.type)) {
        for (const m of t.type.members) {
          if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) names.push(m.name.text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

function socketMembers(): string[] {
  const files = readdirSync(SOCKET_DIR).filter((f) => f.endsWith('.d.ts'));
  const all = new Set<string>();
  for (const f of files) for (const n of typeLiteralMembers(path.join(SOCKET_DIR, f))) all.add(n);
  return [...all].sort();
}

describe('baileys API drift', () => {
  const members = socketMembers();

  it('can read the socket type from node_modules/baileys', () => {
    expect(members.length).toBeGreaterThan(50);
    // Anchors proving the parse worked and the denylist names still exist upstream.
    for (const n of ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'groupMetadata', 'logout', 'ev']) {
      expect(members, n).toContain(n);
    }
  });

  it('every write-ish socket method is denylisted or explicitly reviewed', () => {
    const unreviewed = members.filter(
      (n) => WRITEISH.test(n) && !isWriteApi(n) && !ALLOWED_EXCEPTIONS.includes(n) && !(n in REVIEWED_SAFE),
    );
    expect(
      unreviewed,
      `New/unreviewed Baileys socket methods. Add each to the denylist (test/guard/denylist.ts) or to REVIEWED_SAFE with a reason:\n  ${unreviewed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('REVIEWED_SAFE contains no stale or denylisted names', () => {
    for (const [name, reason] of Object.entries(REVIEWED_SAFE)) {
      expect(reason.length, name).toBeGreaterThan(5);
    }
    const denied = Object.keys(REVIEWED_SAFE).filter((n) => isWriteApi(n));
    expect(denied, 'a name cannot be both reviewed-safe and denylisted').toEqual([]);
  });

  it('every PLAN denylist name that Baileys exposes on the socket still exists (or is a known non-socket export)', () => {
    const nonSocket = new Set(['downloadMediaMessage', 'star', 'offerCall', 'groupJoinApprovalMode', 'sendWAMBuffer']);
    const missing = WRITE_API_DENYLIST.filter((n) => !members.includes(n) && !nonSocket.has(n));
    // Informational drift check: names that vanished upstream may have been renamed.
    expect(missing, 'denylist names no longer on the Baileys socket (renamed upstream?)').toEqual([]);
  });

  it('downloadMediaMessage is still a Baileys export (so the import ban stays meaningful)', () => {
    expect(typeof (baileys as Record<string, unknown>)['downloadMediaMessage']).toBe('function');
    expect(typeof baileys.makeWASocket).toBe('function');
  });
});
