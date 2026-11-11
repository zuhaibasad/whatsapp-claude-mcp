// Native OS dialogs (Windows PowerShell / macOS osascript). Used for the two questions the model must not answer on
// the user's behalf: "delete this old data?" and "where should the data live?". Text goes in through environment
// variables, never into the script, so nothing needs quoting. Never logs the text.
import { spawn } from 'node:child_process';

export interface Dialogs {
  /** true = yes, false = no/closed, null = dialogs are not available here. */
  confirm(title: string, text: string, labels?: { yes: string; no: string }): Promise<boolean | null>;
  /** Chosen folder, '' = cancelled, null = not available here. */
  pickFolder(title: string, initial: string): Promise<string | null>;
}

const TIMEOUT_MS = 10 * 60_000;

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: { code: number | null; out: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { child.kill(); done({ code: null, out: '' }); }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => done(null));
    child.on('close', (code) => done({ code, out: out.trim() }));
  });
}

const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');
const psArgs = (script: string): string[] => ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)];

const PS_OWNER = `
Add-Type -AssemblyName System.Windows.Forms
$o = New-Object System.Windows.Forms.Form
$o.TopMost = $true; $o.ShowInTaskbar = $false; $o.StartPosition = 'CenterScreen'; $o.Opacity = 0; $o.Size = New-Object System.Drawing.Size(1,1)
$o.Show()
`;

export const PS_CONFIRM = `${PS_OWNER}
$r = [System.Windows.Forms.MessageBox]::Show($o, $env:CHATAI_DLG_TEXT, $env:CHATAI_DLG_TITLE, 'YesNo', 'Warning', 'Button2')
Write-Output $r
`;

export const PS_FOLDER = `${PS_OWNER}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:CHATAI_DLG_TEXT
$d.ShowNewFolderButton = $true
if ($env:CHATAI_DLG_INITIAL -and (Test-Path -LiteralPath $env:CHATAI_DLG_INITIAL)) { $d.SelectedPath = $env:CHATAI_DLG_INITIAL }
if ($d.ShowDialog($o) -eq 'OK') { Write-Output $d.SelectedPath }
`;

const AS_CONFIRM = `display dialog (system attribute "CHATAI_DLG_TEXT") with title (system attribute "CHATAI_DLG_TITLE") buttons {(system attribute "CHATAI_DLG_NO"), (system attribute "CHATAI_DLG_YES")} default button (system attribute "CHATAI_DLG_NO") with icon caution`;
const AS_FOLDER = `POSIX path of (choose folder with prompt (system attribute "CHATAI_DLG_TEXT"))`;

export function nativeDialogs(platform: NodeJS.Platform = process.platform): Dialogs {
  if (platform === 'win32') {
    return {
      confirm: async (title, text) => {
        const r = await run('powershell.exe', psArgs(PS_CONFIRM), { CHATAI_DLG_TITLE: title, CHATAI_DLG_TEXT: text });
        return r === null ? null : r.out === 'Yes';
      },
      pickFolder: async (title, initial) => {
        const r = await run('powershell.exe', psArgs(PS_FOLDER), { CHATAI_DLG_TITLE: title, CHATAI_DLG_TEXT: title, CHATAI_DLG_INITIAL: initial });
        return r === null ? null : r.out;
      },
    };
  }
  if (platform === 'darwin') {
    return {
      confirm: async (title, text, labels = { yes: 'Yes', no: 'No' }) => {
        const r = await run('osascript', ['-e', AS_CONFIRM], { CHATAI_DLG_TITLE: title, CHATAI_DLG_TEXT: text, CHATAI_DLG_YES: labels.yes, CHATAI_DLG_NO: labels.no });
        return r === null ? null : r.code === 0 && r.out.endsWith(`button returned:${labels.yes}`);
      },
      pickFolder: async (title) => {
        const r = await run('osascript', ['-e', AS_FOLDER], { CHATAI_DLG_TEXT: title });
        return r === null ? null : r.code === 0 ? r.out.replace(/\/$/, '') : '';
      },
    };
  }
  return { confirm: async () => null, pickFolder: async () => null };
}
