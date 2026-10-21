import { describe, expect, it } from 'vitest';
import { detectMention, normalizeJid } from '../../src/daemon/mentions.js';
import type { RawMessage } from '../../src/core/contracts.js';

const ME = {
  id: '92300111222@s.whatsapp.net',
  lid: '123456789012345@lid',
  names: ['Zuhaib', 'zuhaib bhai'],
};

function msg(patch: Partial<RawMessage> = {}): RawMessage {
  return {
    id: 'm1',
    chatId: '1203@g.us',
    senderId: '92999@s.whatsapp.net',
    senderName: 'Someone',
    ts: 1700000000,
    text: 'hello there',
    quotedId: null,
    quotedSenderId: null,
    mentions: [],
    isFromMe: false,
    hasMedia: false,
    mediaType: null,
    ...patch,
  };
}

describe('normalizeJid', () => {
  it('strips the device suffix and lowercases', () => {
    expect(normalizeJid('92300111222:12@s.whatsapp.net')).toBe('92300111222@s.whatsapp.net');
    expect(normalizeJid('123:5@LID')).toBe('123@lid');
    expect(normalizeJid('1203@g.us')).toBe('1203@g.us');
  });
});

describe('detectMention', () => {
  it('returns at_mention for my id, with or without device suffix', () => {
    expect(detectMention(msg({ mentions: [ME.id] }), ME)).toBe('at_mention');
    expect(detectMention(msg({ mentions: ['92300111222:12@s.whatsapp.net'] }), ME)).toBe('at_mention');
  });

  it('returns at_mention for my lid, with a device suffix', () => {
    expect(detectMention(msg({ mentions: [ME.lid!] }), ME)).toBe('at_mention');
    expect(detectMention(msg({ mentions: ['123456789012345:7@lid'] }), ME)).toBe('at_mention');
  });

  it('returns reply when quoting my message', () => {
    expect(detectMention(msg({ quotedSenderId: '92300111222:3@s.whatsapp.net' }), ME)).toBe('reply');
    expect(detectMention(msg({ quotedSenderId: ME.lid }), ME)).toBe('reply');
  });

  it('prefers at_mention over reply and reply over name', () => {
    const m = msg({ mentions: [ME.id], quotedSenderId: ME.id, text: 'Zuhaib' });
    expect(detectMention(m, ME)).toBe('at_mention');
    expect(detectMention(msg({ quotedSenderId: ME.id, text: 'Zuhaib' }), ME)).toBe('reply');
  });

  it.each([
    'Zuhaib',
    'zuhaib check karo',
    'check karo Zuhaib',
    'Zuhaib, ye dekho',
    '@Zuhaib please',
    'Zuhaib bhai ye check karo',
    'ZUHAIB.',
    'ye baat zuhaib ki hai',
  ])('returns name for text %j', (text) => {
    expect(detectMention(msg({ text }), ME)).toBe('name');
  });

  it('does not match a name inside another word', () => {
    expect(detectMention(msg({ text: 'Zuhaibx ne bola' }), ME)).toBeNull();
    expect(detectMention(msg({ text: 'xZuhaib' }), ME)).toBeNull();
    expect(detectMention(msg({ text: 'Zuhaibé' }), ME)).toBeNull();
  });

  it('returns null for my own messages even if they mention me', () => {
    expect(detectMention(msg({ isFromMe: true, mentions: [ME.id], text: 'Zuhaib' }), ME)).toBeNull();
  });

  it('returns null for unrelated text and missing text', () => {
    expect(detectMention(msg({ text: 'hello' }), ME)).toBeNull();
    expect(detectMention(msg({ text: null }), ME)).toBeNull();
  });

  it('ignores names shorter than 2 chars and empty names', () => {
    const me = { ...ME, names: ['', ' ', 'z'] };
    expect(detectMention(msg({ text: 'z is here' }), me)).toBeNull();
    expect(detectMention(msg({ text: 'hello' }), { ...ME, names: [] })).toBeNull();
  });

  it('escapes regex special characters in names', () => {
    const me = { ...ME, names: ['a.b', 'c+d'] };
    expect(detectMention(msg({ text: 'see a.b now' }), me)).toBe('name');
    expect(detectMention(msg({ text: 'axb now' }), me)).toBeNull();
    expect(detectMention(msg({ text: 'c+d here' }), me)).toBe('name');
  });

  it('matches Unicode names', () => {
    const me = { ...ME, names: ['ذوہیب'] };
    expect(detectMention(msg({ text: 'ذوہیب ye dekho' }), me)).toBe('name');
    expect(detectMention(msg({ text: 'xذوہیب' }), me)).toBeNull();
  });
});
