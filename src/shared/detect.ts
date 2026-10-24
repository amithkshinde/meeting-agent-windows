import { DetectedCall } from './types';

export interface OpenWindow {
  process: string;   // "chrome", "Zoom", "ms-teams"
  title: string;
}

const BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc'];

/**
 * Decides whether any open window looks like a call in progress.
 * - Google Meet: a browser tab titled "Meet - abc-defg-hij".
 * - Zoom: the Zoom app's "Zoom Meeting" window.
 * - Teams: a Teams window titled like a meeting or call (best effort).
 * Windows only reports the title of the tab that is in front, so a Meet tab hidden behind
 * another tab is not seen until it is brought forward.
 */
export function matchCall(windows: OpenWindow[]): DetectedCall | null {
  for (const w of windows) {
    const proc = w.process.toLowerCase();
    const title = w.title.trim();
    if (BROWSERS.includes(proc)) {
      if (/^Meet\s[-–]\s[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(title)) return { app: 'Google Meet', title: cleanBrowserTitle(title) };
      if (/\bGoogle Meet\b/.test(title) && /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/.test(title)) return { app: 'Google Meet', title: cleanBrowserTitle(title) };
    }
    if (proc === 'zoom' || proc === 'zoom.us') {
      if (/^Zoom Meeting$/i.test(title) || /^Zoom Webinar$/i.test(title)) return { app: 'Zoom', title: 'Zoom meeting' };
    }
    if (proc === 'ms-teams' || proc === 'teams') {
      if (/^(Meeting|Call) (with|in)\b/i.test(title) || /\bMeeting compact view\b/i.test(title) || /^.+\| Microsoft Teams$/.test(title) && /\b(meeting|call)\b/i.test(title)) {
        return { app: 'Microsoft Teams', title: title.replace(/\s*\|\s*Microsoft Teams$/, '') };
      }
    }
  }
  return null;
}

function cleanBrowserTitle(title: string): string {
  return title.replace(/\s[-–]\s(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Vivaldi)$/i, '').trim();
}

/** Parses the "process|title" lines the window lister prints. */
export function parseWindowList(output: string): OpenWindow[] {
  const result: OpenWindow[] = [];
  for (const row of output.split(/\r?\n/)) {
    const bar = row.indexOf('|');
    if (bar <= 0) continue;
    const title = row.slice(bar + 1).trim();
    if (title) result.push({ process: row.slice(0, bar).trim(), title });
  }
  return result;
}

/**
 * Smooths the signal so a flicker does not start or stop anything:
 * a call starts after 2 hits in a row and ends after 4 misses in a row.
 */
export class CallDebouncer {
  private hits = 0;
  private misses = 0;
  private active: DetectedCall | null = null;

  feed(current: DetectedCall | null): { started?: DetectedCall; ended?: DetectedCall } {
    if (current) {
      this.misses = 0;
      this.hits += 1;
      if (!this.active && this.hits >= 2) {
        this.active = current;
        return { started: current };
      }
    } else {
      this.hits = 0;
      this.misses += 1;
      if (this.active && this.misses >= 4) {
        const ended = this.active;
        this.active = null;
        return { ended };
      }
    }
    return {};
  }

  get current(): DetectedCall | null {
    return this.active;
  }
}
