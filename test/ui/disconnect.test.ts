import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_OPTIONS, disconnectKeepData, initialScreenFrom, opensDisconnect, screenFor, screenFromSearch,
} from '../../ui/logic.js';

describe('disconnect screen', () => {
  it('routes to the confirmation only while something is linked, and parses the screen hints', () => {
    expect(screenFor('done', false, true)).toBe('disconnect');
    expect(screenFor('syncing', false, true)).toBe('disconnect');
    expect(screenFor('done', false, false)).toBe('done');
    expect(screenFor('ready_to_link', false, true)).toBe('start');
    expect(screenFromSearch('?screen=disconnect')).toBe('disconnect');
    expect(initialScreenFrom({ initialScreen: 'disconnect' })).toBe('disconnect');
    expect(opensDisconnect('disconnect', 'done')).toBe(true);
    expect(opensDisconnect('disconnect', 'needs_accept')).toBe(false);
    expect(opensDisconnect('chats', 'done')).toBe(false);
  });

  it('offers exactly two clear options and nothing is chosen by default', () => {
    expect(DISCONNECT_OPTIONS.map((o) => o.label)).toEqual([
      'Disconnect and keep my chat history on this computer',
      'Disconnect and delete everything',
    ]);
    expect(disconnectKeepData(null)).toBeNull();
    expect(disconnectKeepData('keep')).toBe(true);
    expect(disconnectKeepData('delete')).toBe(false);
  });
});
