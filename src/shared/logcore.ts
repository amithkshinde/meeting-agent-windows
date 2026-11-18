/** Things that must never end up in a log or a report: API keys, email addresses and the account name in paths. */
export function redact(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[key]')
    .replace(/\b(bearer|token|api[_-]?key|key)([=:]\s*|\s+)[A-Za-z0-9_.-]{20,}/gi, '$1$2[key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\~')
    .replace(/\/Users\/[^/\s]+/g, '/Users/~');
}

export type Level = 'debug' | 'info' | 'warn' | 'error';
const TAG: Record<Level, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

export function formatLine(level: Level, category: string, message: string, date = new Date()): string {
  const text = redact(message).replace(/\r?\n/g, ' ⏎ ');
  return `${date.toISOString()}  ${TAG[level]}  [${category}]  ${text}\n`;
}

// MARK: why a recording ended

export type EndReason = 'manualStop' | 'callEnded' | 'captureEnded' | 'recorderError' | 'stalled' | 'sleep' | 'diskFull' | 'quit' | 'crashed' | 'rendererCrashed' | 'startFailed' | 'unknown';

const PLAIN: Record<EndReason, string> = {
  manualStop: 'stopped by you',
  callEnded: 'the call ended',
  captureEnded: 'Windows stopped sharing the screen',
  recorderError: 'the recorder reported an error',
  stalled: 'capture went silent',
  sleep: 'the PC went to sleep',
  diskFull: 'the disk was almost full',
  quit: 'the app was quit',
  crashed: 'the app closed unexpectedly',
  rendererCrashed: 'the recording window crashed',
  startFailed: 'it could not start',
  unknown: 'unknown'
};

export const plain = (reason: EndReason): string => PLAIN[reason] ?? 'unknown';
export const isNormal = (reason: EndReason): boolean => reason === 'manualStop' || reason === 'callEnded' || reason === 'quit';

export interface LedgerEntry {
  id: string;
  app: string;
  startedAt: string;
  endedAt?: string;
  automatic: boolean;
  reason?: EndReason;
  detail?: string;
  resumedFrom?: string;
  freeGBAtStart?: number;
}

export function failures(entries: LedgerEntry[], days: number, now = Date.now()): LedgerEntry[] {
  const cutoff = now - days * 86_400_000;
  return entries.filter((e) => Date.parse(e.endedAt ?? e.startedAt) >= cutoff && e.reason !== undefined && !isNormal(e.reason) && e.reason !== 'startFailed');
}

export function countRecent(entries: LedgerEntry[], days: number, now = Date.now()): number {
  const cutoff = now - days * 86_400_000;
  return entries.filter((e) => Date.parse(e.startedAt) >= cutoff).length;
}

/** Entries that were never closed were cut off by a crash or a power cut. */
export function closeOpen(entries: LedgerEntry[], at = new Date()): LedgerEntry[] {
  return entries.map((e) => (e.endedAt ? e : { ...e, endedAt: at.toISOString(), reason: 'crashed' as EndReason, detail: 'Found unfinished at the next launch.' }));
}

export function ledgerReport(entries: LedgerEntry[], now = Date.now(), limit = 25): string {
  const recent = entries.slice(-limit);
  if (!recent.length) return 'No recordings yet.';
  const lines = ['Recent recordings (newest last):'];
  for (const e of recent) {
    const start = new Date(e.startedAt);
    const seconds = Math.max(0, ((e.endedAt ? Date.parse(e.endedAt) : Date.parse(e.startedAt)) - start.getTime()) / 1000);
    const how = e.reason ? plain(e.reason) : 'still open';
    let line = `• ${start.toISOString().slice(0, 16).replace('T', ' ')} · ${e.app} · ${Math.round(seconds / 60)} min · ${e.automatic ? 'auto' : 'manual'} · ended: ${how}`;
    if (e.detail) line += ` (${e.detail})`;
    if (e.resumedFrom) line += ' · continued from an interrupted recording';
    lines.push(line);
  }
  lines.push('', `Last 30 days: ${countRecent(entries, 30, now)} recordings, ${failures(entries, 30, now).length} ended unexpectedly.`);
  return lines.join('\n');
}

// MARK: rotation decisions (the file work lives in main/log.ts)

export function rotatedNames(base: string, keep: number): string[] {
  return Array.from({ length: keep }, (_, i) => `${base}.${i + 1}`);
}

// MARK: restarting after an interruption

/** Whether to start a new recording after Windows or the recorder interrupted one. */
export function shouldResume(reason: EndReason, resumesSoFar: number, callStillThere: boolean, maxResumes = 3): boolean {
  if (resumesSoFar >= maxResumes || !callStillThere) return false;
  return reason === 'captureEnded' || reason === 'recorderError' || reason === 'stalled' || reason === 'rendererCrashed';
}

export type DiskVerdict = 'fine' | 'low' | 'critical';
export function diskVerdict(freeBytes: number | null): DiskVerdict {
  if (freeBytes === null) return 'fine';
  if (freeBytes < 1_073_741_824) return 'critical';
  if (freeBytes < 3 * 1_073_741_824) return 'low';
  return 'fine';
}
