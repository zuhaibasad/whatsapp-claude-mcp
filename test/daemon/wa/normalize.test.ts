import { describe, expect, it } from 'vitest';
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { extractDelete, extractEdit, normalizeMessage } from '../../../src/daemon/wa/normalize.js';

const ME = '111@s.whatsapp.net';
const GROUP = '1203@g.us';
const mk = (over: Partial<WAMessage> & { message?: proto.IMessage }): WAMessage =>
  ({ key: { remoteJid: GROUP, id: 'M1', participant: '222@s.whatsapp.net', fromMe: false }, messageTimestamp: 1700000000, ...over }) as WAMessage;

describe('normalizeMessage', () => {
  it('plain conversation in a group', () => {
    const r = normalizeMessage(mk({ message: { conversation: 'hi' }, pushName: 'Ali' }), ME);
    expect(r).toMatchObject({
      id: 'M1', chatId: GROUP, senderId: '222@s.whatsapp.net', senderName: 'Ali', ts: 1700000000,
      text: 'hi', isFromMe: false, hasMedia: false, mediaType: null, mentions: [], quotedId: null,
    });
  });

  it('extended text with mention and quote', () => {
    const r = normalizeMessage(mk({
      message: { extendedTextMessage: { text: '@me look', contextInfo: { mentionedJid: [ME], stanzaId: 'Q1', participant: '333@s.whatsapp.net' } } },
    }), ME);
    expect(r).toMatchObject({ text: '@me look', mentions: [ME], quotedId: 'Q1', quotedSenderId: '333@s.whatsapp.net' });
  });

  it('image with caption is media with text', () => {
    const r = normalizeMessage(mk({ message: { imageMessage: { caption: 'pic' } } }), ME);
    expect(r).toMatchObject({ text: 'pic', hasMedia: true, mediaType: 'image' });
  });

  it('media without caption keeps null text', () => {
    const r = normalizeMessage(mk({ message: { stickerMessage: {} } }), ME);
    expect(r).toMatchObject({ text: null, hasMedia: true, mediaType: 'sticker' });
  });

  it('unwraps ephemeral and view-once', () => {
    expect(normalizeMessage(mk({ message: { ephemeralMessage: { message: { conversation: 'eph' } } } }), ME)?.text).toBe('eph');
    expect(normalizeMessage(mk({ message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'vo' } } } } }), ME))
      .toMatchObject({ text: 'vo', mediaType: 'image' });
    expect(normalizeMessage(mk({ message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'doc' } } } } }), ME))
      .toMatchObject({ text: 'doc', mediaType: 'document' });
  });

  it('returns null for status, reactions, protocol, sender-key-only, poll updates, empty', () => {
    expect(normalizeMessage(mk({ key: { remoteJid: 'status@broadcast', id: 'S', participant: '2@s.whatsapp.net' }, message: { conversation: 'x' } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: { reactionMessage: { text: '+1' } } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'X' } } } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: { senderKeyDistributionMessage: { groupId: GROUP } } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: { pollUpdateMessage: {} } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: { conversation: '' } }), ME)).toBeNull();
    expect(normalizeMessage(mk({ message: undefined }), ME)).toBeNull();
  });

  it('direct chat uses remoteJid, fromMe uses meId', () => {
    const direct = normalizeMessage(mk({ key: { remoteJid: '444@s.whatsapp.net', id: 'D1', fromMe: false }, message: { conversation: 'yo' } }), ME);
    expect(direct?.senderId).toBe('444@s.whatsapp.net');
    const mine = normalizeMessage(mk({ key: { remoteJid: '444@s.whatsapp.net', id: 'D2', fromMe: true }, message: { conversation: 'ok' } }), ME);
    expect(mine).toMatchObject({ senderId: ME, isFromMe: true });
  });

  it('prefers the phone-number alt over a LID sender', () => {
    const g = normalizeMessage(mk({ key: { remoteJid: GROUP, id: 'L1', participant: '99@lid', participantAlt: '555@s.whatsapp.net' }, message: { conversation: 'a' } }), ME);
    expect(g?.senderId).toBe('555@s.whatsapp.net');
    const d = normalizeMessage(mk({ key: { remoteJid: '99@lid', remoteJidAlt: '555@s.whatsapp.net', id: 'L2' }, message: { conversation: 'a' } }), ME);
    expect(d?.senderId).toBe('555@s.whatsapp.net');
  });

  it('converts Long timestamps', () => {
    const r = normalizeMessage(mk({ messageTimestamp: { low: 1700000000, high: 0, unsigned: true } as never, message: { conversation: 'a' } }), ME);
    expect(r?.ts).toBe(1700000000);
  });
});

describe('extractEdit / extractDelete', () => {
  it('revoke -> extractDelete', () => {
    const m = mk({ message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'TARGET' } } } });
    expect(extractDelete(m)).toEqual({ chatId: GROUP, messageId: 'TARGET' });
    expect(extractEdit(m)).toBeNull();
  });

  it('protocol edit -> extractEdit', () => {
    const m = mk({
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'TARGET' }, editedMessage: { conversation: 'new' } } },
    });
    expect(extractEdit(m)).toEqual({ chatId: GROUP, messageId: 'TARGET', newText: 'new' });
    expect(extractDelete(m)).toBeNull();
  });

  it('messages.update style editedMessage wrapper uses key.id', () => {
    const m = mk({ key: { remoteJid: GROUP, id: 'TARGET' }, message: { editedMessage: { message: { conversation: 'newer' } } } });
    expect(extractEdit(m)).toEqual({ chatId: GROUP, messageId: 'TARGET', newText: 'newer' });
  });

  it('plain message is neither', () => {
    const m = mk({ message: { conversation: 'x' } });
    expect(extractEdit(m)).toBeNull();
    expect(extractDelete(m)).toBeNull();
  });
});
