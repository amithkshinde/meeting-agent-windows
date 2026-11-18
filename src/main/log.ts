import * as fs from 'node:fs';
import * as path from 'node:path';
import { Level, formatLine, rotatedNames } from '../shared/logcore';
import * as store from './store';

const MAX_BYTES = 1_500_000;
const KEEP = 3;

export const logsDir = (): string => {
  const dir = path.join(store.root(), 'Logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const logFile = (): string => path.join(logsDir(), 'meeting-agent.log');
const markerFile = (): string => path.join(logsDir(), 'running.marker');

function rotateIfNeeded(adding: number): void {
  const file = logFile();
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size + adding <= MAX_BYTES) return;
  const names = rotatedNames(file, KEEP);
  try { fs.rmSync(names[KEEP - 1], { force: true }); } catch { /* ignore */ }
  for (let i = KEEP - 2; i >= 0; i--) {
    try { if (fs.existsSync(names[i])) fs.renameSync(names[i], names[i + 1]); } catch { /* ignore */ }
  }
  try { fs.renameSync(file, names[0]); } catch { /* ignore */ }
}

function write(level: Level, category: string, message: string): void {
  const line = formatLine(level, category, message);
  try {
    rotateIfNeeded(line.length);
    fs.appendFileSync(logFile(), line);
  } catch { /* logging must never break the app */ }
  if (level === 'error') console.error(line.trimEnd()); else console.log(line.trimEnd());
}

export const log = {
  debug: (category: string, message: string) => write('debug', category, message),
  info: (category: string, message: string) => write('info', category, message),
  warn: (category: string, message: string) => write('warn', category, message),
  error: (category: string, message: string) => write('error', category, message)
};

/** The last part of the log, oldest first, for a report. */
export function tail(maxChars = 30_000): string {
  const files = [logFile(), ...rotatedNames(logFile(), KEEP)].filter((f) => fs.existsSync(f));
  const pieces: string[] = [];
  let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    pieces.unshift(text);
    total += text.length;
    if (total >= maxChars) break;
  }
  const joined = pieces.join('');
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(-maxChars);
  const newline = cut.indexOf('\n');
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

/** Notes whether the last run ended cleanly. Returns the previous run's details if it did not. */
export function beginSession(version: string): { startedAt: string; version: string } | null {
  let previous: { startedAt: string; version: string } | null = null;
  try {
    const [stamp, ver] = fs.readFileSync(markerFile(), 'utf8').split('|');
    const seconds = Number(stamp);
    if (Number.isFinite(seconds)) previous = { startedAt: new Date(seconds).toISOString(), version: (ver ?? '').trim() };
  } catch { /* no marker: the last run ended cleanly */ }
  try { fs.writeFileSync(markerFile(), `${Date.now()}|${version}`); } catch { /* ignore */ }
  return previous;
}

export function endSession(): void {
  try { fs.rmSync(markerFile(), { force: true }); } catch { /* ignore */ }
}
