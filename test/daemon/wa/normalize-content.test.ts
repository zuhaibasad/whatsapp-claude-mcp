import { describe, expect, it } from 'vitest';
import type { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { normalizeMessage, parseVcard } from '../../../src/daemon/wa/normalize.js';

const ME = '111@s.whatsapp.net';
const mk = (message: proto.IMessage): WAMessage =>
  ({ key: { remoteJid: '1203@g.us', id: 'M1', participant: '222@s.whatsapp.net', fromMe: false }, messageTimestamp: 1700000000, message }) as WAMessage;

describe('quoted replies', () => {
  it('quote with text', () => {
    const r = normalizeMessage(mk({ extendedTextMessage: { text: 'ok', contextInfo: { stanzaId: 'Q', participant: '3@s.whatsapp.net', quotedMessage: { conversation: 'send the file' } } } }), ME);
    expect(r).toMatchObject({ quotedId: 'Q', quotedText: 'send the file' });
  });
  it('quote text is capped at 300 chars', () => {
    const r = normalizeMessage(mk({ extendedTextMessage: { text: 'ok', contextInfo: { stanzaId: 'Q', quotedMessage: { conversation: 'x'.repeat(900) } } } }), ME);
    expect([...(r?.quotedText ?? '')]).toHaveLength(300);
  });
  it('quote of media gives a placeholder, or the caption when present', () => {
    const a = normalizeMessage(mk({ extendedTextMessage: { text: 'nice', contextInfo: { stanzaId: 'Q', quotedMessage: { imageMessage: {} } } } }), ME);
    expect(a?.quotedText).toBe('[image]');
    const b = normalizeMessage(mk({ extendedTextMessage: { text: 'nice', contextInfo: { stanzaId: 'Q', quotedMessage: { imageMessage: { caption: 'cap' } } } } }), ME);
    expect(b?.quotedText).toBe('cap');
  });
  it('no quote gives null', () => {
    expect(normalizeMessage(mk({ conversation: 'hi' }), ME)?.quotedText).toBeNull();
  });
});

describe('location and contact cards', () => {
  it('location', () => {
    const r = normalizeMessage(mk({ locationMessage: { degreesLatitude: 24.86, degreesLongitude: 67.01, name: 'Office', address: 'Karachi' } }), ME);
    expect(r).toMatchObject({ text: '[location]', mediaType: 'location', extra: { location: { lat: 24.86, lng: 67.01, name: 'Office', address: 'Karachi' } } });
  });
  it('live location', () => {
    const r = normalizeMessage(mk({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }), ME);
    expect(r).toMatchObject({ text: '[location]', extra: { location: { lat: 1, lng: 2 } } });
  });
  it('vCard with two numbers', () => {
    const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ali Khan\r\nTEL;type=CELL;waid=923001234567:+92 300 1234567\r\nitem1.TEL:+92 21 111\r\nEND:VCARD';
    const r = normalizeMessage(mk({ contactMessage: { displayName: 'Ali', vcard } }), ME);
    expect(r).toMatchObject({ text: '[contact card]', extra: { contacts: [{ name: 'Ali Khan', phones: ['+92 300 1234567', '+92 21 111'] }] } });
  });
  it('contacts array, with displayName fallback', () => {
    const r = normalizeMessage(mk({ contactsArrayMessage: { contacts: [{ displayName: 'Z', vcard: 'TEL:+1' }, { displayName: 'Y', vcard: 'FN:Why\nTEL:+2' }] } }), ME);
    expect(r?.extra?.contacts).toEqual([{ name: 'Z', phones: ['+1'] }, { name: 'Why', phones: ['+2'] }]);
    expect(parseVcard(null, 'N')).toEqual({ name: 'N', phones: [] });
  });
});

describe('image download reference', () => {
  const key = new Uint8Array([1, 2, 3]);
  it('images carry mediaKey (base64), path, mimetype and size', () => {
    const r = normalizeMessage(mk({ imageMessage: { mediaKey: key, directPath: '/v/t62/abc', url: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg', fileLength: 2048 } }), ME);
    expect(r?.media).toEqual({ kind: 'image', mediaKey: 'AQID', directPath: '/v/t62/abc', url: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg', fileLength: 2048 });
  });
  it('an image sent as a document counts; a PDF, or an image without keys, does not', () => {
    expect(normalizeMessage(mk({ documentMessage: { mediaKey: key, directPath: '/d', mimetype: 'image/png' } }), ME)?.media?.kind).toBe('image');
    expect(normalizeMessage(mk({ documentMessage: { mediaKey: key, directPath: '/d', mimetype: 'application/pdf' } }), ME)?.media).toBeNull();
    expect(normalizeMessage(mk({ imageMessage: { caption: 'x' } }), ME)?.media).toBeNull();
  });
});
