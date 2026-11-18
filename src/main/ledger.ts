import * as fs from 'node:fs';
import * as path from 'node:path';
import { EndReason, LedgerEntry, closeOpen } from '../shared/logcore';
import { logsDir } from './log';

const MAX = 400;
const file = (): string => path.join(logsDir(), 'recordings-ledger.json');

export function read(): LedgerEntry[] {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as LedgerEntry[]; } catch { return []; }
}

function save(entries: LedgerEntry[]): void {
  try { fs.writeFileSync(file(), JSON.stringify(entries.slice(-MAX), null, 2)); } catch { /* ignore */ }
}

export function begin(entry: LedgerEntry): void {
  save([...read().filter((e) => e.id !== entry.id), entry]);
}

export function finish(id: string, reason: EndReason, detail = ''): void {
  const entries = read();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.endedAt) return;
  entry.endedAt = new Date().toISOString();
  entry.reason = reason;
  entry.detail = detail;
  save(entries);
}

/** Anything left open was cut off by a crash or a power cut. Returns the ones just closed. */
export function closeOpenAsCrashed(): LedgerEntry[] {
  const before = read();
  const open = before.filter((e) => !e.endedAt);
  if (open.length) save(closeOpen(before));
  return open;
}
