import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bookmark, CallRecord, Settings } from '../shared/types';
import { TLine, parse } from '../shared/transcript';

/** Everything lives in Videos\MeetingAgent, one folder per call. */
export function root(): string {
  const dir = process.env.MEETING_AGENT_HOME ?? path.join(os.homedir(), 'Videos', 'MeetingAgent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function folder(id: string): string {
  return path.join(root(), id);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'call';
}

export function newCall(app: string, title: string, now = new Date()): CallRecord {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}`;
  const id = `${stamp}-${slug(app)}`;
  let unique = id;
  for (let n = 2; fs.existsSync(folder(unique)); n++) unique = `${id}-${n}`;
  fs.mkdirSync(folder(unique), { recursive: true });
  const call: CallRecord = {
    id: unique, startedAt: now.toISOString(), durationSec: 0, app, title: title || `${app} call`,
    project: '', status: 'recording', summary: '', decisions: [], promises: []
  };
  writeCall(call);
  return call;
}

export function writeCall(call: CallRecord): void {
  fs.writeFileSync(path.join(folder(call.id), 'call.json'), JSON.stringify(call, null, 2));
}

export function readCall(id: string): CallRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder(id), 'call.json'), 'utf8')) as CallRecord;
  } catch {
    return null;
  }
}

export function listCalls(): CallRecord[] {
  const calls: CallRecord[] = [];
  for (const entry of fs.readdirSync(root(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const call = readCall(entry.name);
    if (call) calls.push(call);
  }
  return calls.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function transcriptPath(id: string): string {
  return path.join(folder(id), 'transcript.txt');
}

export function readTranscriptRaw(id: string): string {
  try {
    return fs.readFileSync(transcriptPath(id), 'utf8');
  } catch {
    return '';
  }
}

export function readTranscript(id: string): TLine[] {
  return parse(readTranscriptRaw(id));
}

export function readBookmarks(id: string): Bookmark[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder(id), 'bookmarks.json'), 'utf8')) as Bookmark[];
  } catch {
    return [];
  }
}

export function addBookmark(id: string, t: number, note = ''): Bookmark[] {
  const all = [...readBookmarks(id), { t, note }].sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(folder(id), 'bookmarks.json'), JSON.stringify(all, null, 2));
  return all;
}

// Settings (never the key itself; see secrets.ts)

const DEFAULTS: Omit<Settings, 'hasKey' | 'keyKind'> = {
  userName: os.userInfo().username,
  language: 'auto',
  script: 'roman',
  watchCalls: true
};

export function readSettings(): Omit<Settings, 'hasKey' | 'keyKind'> {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(root(), 'settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch: Partial<Settings>): void {
  const { hasKey: _h, keyKind: _k, ...clean } = patch as Settings;
  fs.writeFileSync(path.join(root(), 'settings.json'), JSON.stringify({ ...readSettings(), ...clean }, null, 2));
}
