// Runs before the setup panel opens: (1) offers to delete leftover data from earlier installs, (2) asks where the
// data should live. Both questions are native OS dialogs, so the model cannot answer them. Returns null to carry on,
// or a plain-language message that the tool returns instead of opening the panel.
import fs from 'node:fs';
import path from 'node:path';
import type { KeyringBackend } from '../core/contracts.js';
import { defaultDataDir, readLocation, writeLocation, type DataPaths } from '../core/paths.js';
import type { Dialogs } from './dialog.js';
import { isMsixRedirected } from './diagnose.js';
import { describeBytes, removeLeftover, scanLeftovers } from './leftovers.js';

export interface PreflightDeps {
  paths: DataPaths;
  keyring: KeyringBackend;
  dialogs: Dialogs;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function preflight(d: PreflightDeps): Promise<string | null> {
  const env = d.env ?? process.env;
  const platform = d.platform ?? process.platform;
  const { paths, keyring, dialogs } = d;

  // 1. Leftovers.
  const items = scanLeftovers(paths, { keyring, env, platform, declined: readLocation(env, platform).declined });
  if (items.length > 0) {
    const shown = items.slice(0, 6).map((i) => `• ${i.dir} (${describeBytes(i.bytes)})\n  ${i.why}`).join('\n');
    const more = items.length > 6 ? `\n…and ${items.length - 6} more.` : '';
    const ok = await dialogs.confirm(
      'ChatAI for WhatsApp: old data found',
      `Saved WhatsApp data from an earlier ChatAI / WhatsApp Bridge was found on this computer:\n\n${shown}${more}\n\nDelete it? This only removes ChatAI's own stored copy and its encryption key. Your WhatsApp account and phone are not affected. It cannot be undone.\n\nYes = delete, No = keep.`,
      { yes: 'Delete', no: 'Keep' },
    );
    const blocking = items.filter((i) => i.kind === 'unreadable');
    if (ok === true) {
      for (const i of items) {
        try { removeLeftover(i, keyring); } catch (e) {
          return `I could not remove ${i.dir}: ${e instanceof Error ? e.message : 'unknown error'}. Quit Claude completely, reopen it and try again.`;
        }
      }
    } else if (ok === false) {
      writeLocation({ declined: [...new Set([...readLocation(env, platform).declined, ...items.filter((i) => i.kind === 'old').map((i) => i.dir)])] }, env, platform);
      if (blocking.length > 0) {
        return `Setup cannot continue: ${blocking[0]!.dir} holds old data that can no longer be opened, and it was kept at your request. Delete that folder yourself (or say "set up WhatsApp" again and choose Delete).`;
      }
    } else if (blocking.length > 0) {
      return `Setup cannot continue: ${blocking[0]!.dir} holds old data that can no longer be opened. Quit Claude, delete that folder, remove the "chatai" entries from the Windows Credential Manager (macOS: Keychain Access), then set up again.`;
    }
  }

  // 2. Where should the data live?
  if (env['CHATAI_HOME']) return null;
  const loc = readLocation(env, platform);
  if (loc.dataDir) {
    return norm(loc.dataDir) === norm(paths.dataDir) ? null : restartMessage(loc.dataDir);
  }
  if (norm(paths.dataDir) !== norm(defaultDataDir(env, platform))) return null; // explicit --data-dir / project mode
  if (fs.existsSync(paths.storeDb)) { // an existing, working install: keep it where it is
    writeLocation({ dataDir: paths.dataDir }, env, platform);
    return null;
  }
  const useDefault = await dialogs.confirm(
    'ChatAI for WhatsApp: where to store your data',
    `ChatAI keeps an encrypted copy of the WhatsApp chats you select (messages, images and their text).\n\nStore it in the default location?\n\n${paths.dataDir}\n\nYes = use this location, No = choose another folder or drive.`,
    { yes: 'Use this', no: 'Choose folder' },
  );
  if (useDefault === null) return null; // no dialogs on this system: default location
  if (useDefault) {
    writeLocation({ dataDir: paths.dataDir }, env, platform);
    return null;
  }
  const picked = await dialogs.pickFolder('Choose the folder or drive for ChatAI\'s WhatsApp data', path.dirname(paths.dataDir));
  if (!picked) return 'No folder was chosen, so nothing was set up. Say "set up WhatsApp" when you are ready to choose.';
  const target = path.basename(picked).toLowerCase() === 'chatai' ? picked : path.join(picked, 'chatai');
  if (isMsixRedirected(target)) {
    return 'That folder is inside Claude Desktop\'s private storage, which other programs cannot see. Please choose a normal folder, for example on another drive.';
  }
  if (!writable(target)) return `I cannot write to ${target}. Please choose another folder.`;
  writeLocation({ dataDir: target }, env, platform);
  return norm(target) === norm(paths.dataDir) ? null : restartMessage(target);
}

function restartMessage(dir: string): string {
  return `Your data folder is set to ${dir}. Quit Claude completely (not just close the window), open it again, then say "set up WhatsApp" to continue.`;
}
