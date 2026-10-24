import { app, clipboard, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fb from '../shared/feedback';
import * as store from './store';

/** Set these in package.json under "meetingAgent" so nobody's address is written into the source. */
function config(): { email: string; endpoint: string; repo: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { meetingAgent?: Record<string, string> };
    const c = pkg.meetingAgent ?? {};
    return { email: c.feedbackEmail ?? '', endpoint: c.feedbackEndpoint ?? '', repo: c.repo ?? 'amithkshinde/meeting-agent-windows' };
  } catch {
    return { email: '', endpoint: '', repo: 'amithkshinde/meeting-agent-windows' };
  }
}

const file = () => path.join(store.root(), 'feedback.json');

export function list(): fb.FeedbackEntry[] {
  try {
    return (JSON.parse(fs.readFileSync(file(), 'utf8')) as fb.FeedbackEntry[]).sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function save(entries: fb.FeedbackEntry[]): void {
  fs.writeFileSync(file(), JSON.stringify(entries, null, 2));
}

export function capabilities(): { email: boolean; endpoint: boolean } {
  const c = config();
  return { email: fb.isValidEmail(c.email), endpoint: c.endpoint.startsWith('https://') };
}

function details(include: boolean, log: boolean): string {
  if (!include) return '';
  const lines = [`App: Meeting Agent ${app.getVersion()}`, `Windows: ${os.release()} (${os.arch()})`, `Chip: ${os.cpus()[0]?.model ?? 'unknown'}`];
  if (log) lines.push('', '(activity log is not recorded on Windows yet)');
  return lines.join('\n');
}

export interface SendInput {
  kind: fb.FeedbackKind; rating: number | null; message: string; anonymous: boolean; name: string; email: string;
  includeDetails: boolean; includeLog: boolean;
}

/** route: "auto" picks online, then email, then GitHub. */
export async function send(input: SendInput, route: 'auto' | 'online' | 'email' | 'github' | 'copied'): Promise<{ ok: boolean; message: string }> {
  const c = config();
  const entry = fb.makeEntry({ ...input, details: details(input.includeDetails, input.includeLog) });
  if (!entry.message) return { ok: false, message: 'Write a message first.' };
  const entries = [entry, ...list()];
  save(entries);
  const mark = (via: fb.FeedbackEntry['sentVia']) => {
    entry.sentVia = via;
    save(entries);
  };

  const chosen = route === 'auto' ? (capabilities().endpoint ? 'online' : capabilities().email ? 'email' : 'github') : route;
  if (chosen === 'online') {
    try {
      const res = await fetch(c.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(fb.payload(entry, 'Meeting Agent for Windows', app.getVersion()))
      });
      if (!res.ok) throw new Error(String(res.status));
      mark('online');
      return { ok: true, message: 'Sent. Thank you, this really helps.' + (!entry.anonymous && fb.isValidEmail(entry.email) ? " I'll write back if I have questions." : '') };
    } catch {
      return { ok: false, message: 'Could not reach the server, so it is saved on this PC only. Try "Other ways to send".' };
    }
  }
  if (chosen === 'email') {
    const url = fb.mailtoUrl(c.email, entry);
    if (!url) return { ok: false, message: 'No email address is set up for feedback.' };
    await shell.openExternal(url);
    mark('email');
    return { ok: true, message: 'Your mail app has the message ready. Press Send there to finish.' };
  }
  if (chosen === 'github') {
    await shell.openExternal(fb.githubUrl(c.repo, entry));
    mark('github');
    return { ok: true, message: 'Your browser has a draft issue ready. Press "Submit new issue" there to finish.' };
  }
  clipboard.writeText(fb.body(entry));
  mark('copied');
  return { ok: true, message: 'Copied. Paste it wherever you like.' };
}
