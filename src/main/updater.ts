import { app, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ReleaseInfo, headline, isNewer, parseRelease, pickInstaller, shouldRemind } from '../shared/update';
import { config } from './feedbackService';
import { log } from './log';
import * as store from './store';

export type UpdateState = { kind: 'idle' } | { kind: 'checking' } | { kind: 'upToDate' } | { kind: 'available'; version: string; headline: string } | { kind: 'failed'; message: string };

let state: UpdateState = { kind: 'idle' };
let latest: ReleaseInfo | null = null;
let notify: ((s: UpdateState, remind: boolean) => void) | null = null;
let timer: NodeJS.Timeout | null = null;

const remindFile = (tag: string): string => path.join(store.root(), 'Logs', `update-reminded-${tag.replace(/[^\w.-]/g, '_')}.txt`);

export const getState = (): UpdateState => state;

export function start(onChange: (s: UpdateState, remind: boolean) => void): void {
  notify = onChange;
  setTimeout(() => void check(false), 25_000).unref?.();
  timer = setInterval(() => void check(false), 12 * 3600_000);
  timer.unref?.();
}

export async function check(manual: boolean): Promise<UpdateState> {
  state = { kind: 'checking' };
  notify?.(state, false);
  try {
    const res = await fetch(`https://api.github.com/repos/${config().repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `MeetingAgent/${app.getVersion()}` }
    });
    if (res.status === 404) {
      log.info('update', 'No release published yet');
      state = { kind: 'upToDate' };
    } else if (!res.ok) {
      log.warn('update', `Update check got HTTP ${res.status}`);
      state = { kind: 'failed', message: `GitHub answered ${res.status}` };
    } else {
      const release = parseRelease(await res.json());
      if (release && isNewer(release.tag, app.getVersion())) {
        latest = release;
        log.info('update', `Version ${release.tag} is available (installed ${app.getVersion()})`);
        state = { kind: 'available', version: release.tag.replace(/^(windows-|mac-)?v/i, ''), headline: headline(release.notes) };
        let last: number | null = null;
        try { last = Number(fs.readFileSync(remindFile(release.tag), 'utf8')); } catch { /* never reminded */ }
        const remind = manual || shouldRemind(last);
        if (remind) { try { fs.writeFileSync(remindFile(release.tag), String(Date.now())); } catch { /* ignore */ } }
        notify?.(state, remind);
        return state;
      }
      log.info('update', `Up to date (${app.getVersion()})`);
      state = { kind: 'upToDate' };
    }
  } catch (error) {
    log.warn('update', `Update check failed: ${(error as Error).message}`);
    state = { kind: 'failed', message: (error as Error).message };
  }
  notify?.(state, false);
  return state;
}

/** Opens the installer for this PC in the browser, or the release page if there is no matching file. */
export async function download(): Promise<void> {
  if (!latest) return;
  const installer = pickInstaller(latest, process.arch);
  if (installer) {
    log.info('update', `Downloading ${installer.split('/').pop()}`);
    await shell.openExternal(installer);
  } else if (latest.page) {
    log.warn('update', 'No Windows installer in the release; opening the release page');
    await shell.openExternal(latest.page);
  }
}
