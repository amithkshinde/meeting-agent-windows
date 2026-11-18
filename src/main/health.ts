import { app, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ledgerReport, redact } from '../shared/logcore';
import { config } from './feedbackService';
import * as ledger from './ledger';
import { log, logsDir, tail } from './log';
import * as parakeet from './parakeet';
import * as store from './store';

export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export const gigabytes = (bytes: number): string => `${(bytes / 1_073_741_824).toFixed(1)} GB`;

export function machineLine(): string {
  return `Windows ${os.release()} (${os.arch()}) · ${os.cpus()[0]?.model ?? 'unknown chip'} · ${Math.round(os.totalmem() / 1_073_741_824)} GB memory`;
}

/** Plain text a person can read before sending. Keys, emails and the account name are removed from every line. */
export function reportText(note = ''): string {
  const free = freeBytes(store.root());
  const lines = [
    `Meeting Agent for Windows report · ${new Date().toISOString()}`,
    `Version: ${app.getVersion()}`,
    machineLine(),
    `Free disk space: ${free === null ? 'unknown' : gigabytes(free)}`,
    `Watch for calls: ${store.readSettings().watchCalls ? 'on' : 'off'}`,
    `Transcription: ${parakeet.describe()}`
  ];
  if (note.trim()) lines.push('', 'What happened (from the person):', redact(note.trim()));
  lines.push('', ledgerReport(ledger.read()), '', '───── Activity log (newest at the bottom) ─────', tail(30_000));
  return lines.join('\n');
}

export function saveReport(note = ''): string | null {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '_' : ''));
  const file = path.join(app.getPath('desktop'), `MeetingAgent-report-${stamp}.txt`);
  try {
    fs.writeFileSync(file, reportText(note));
    log.info('report', 'Saved a report to the Desktop');
    return file;
  } catch (error) {
    log.error('report', `Could not save a report: ${(error as Error).message}`);
    return null;
  }
}

export interface ReportInput { note: string; name: string; email: string; anonymous: boolean }

/** Sends the report the best way available: posted online if an address is set, otherwise saved to the Desktop with an email draft. */
export async function sendReport(input: ReportInput): Promise<{ ok: boolean; message: string }> {
  const c = config();
  const text = reportText(input.note);
  if (c.endpoint.startsWith('https://')) {
    try {
      const payload: Record<string, unknown> = {
        kind: 'report', anonymous: input.anonymous, message: input.note || 'Automatic report', details: text, text,
        subject: 'Meeting Agent problem report', app: 'Meeting Agent for Windows', version: app.getVersion(), date: new Date().toISOString()
      };
      if (!input.anonymous) { payload.name = input.name; payload.email = input.email; }
      const res = await fetch(c.endpoint, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(String(res.status));
      log.info('report', 'Report sent online');
      return { ok: true, message: 'Report sent. Thank you.' };
    } catch (error) {
      log.warn('report', `Could not send the report online (${(error as Error).message}); falling back to a file`);
    }
  }
  const file = saveReport(input.note);
  if (!file) return { ok: false, message: 'Could not save the report. Use “Open logs folder” and send the newest file.' };
  shell.showItemInFolder(file);
  if (c.email) {
    const body = `Hi,\n\nThe recorder had a problem. I have attached the report file from my Desktop (${path.basename(file)}).\n\n${input.note}\n`;
    await shell.openExternal(`mailto:${c.email}?subject=${encodeURIComponent('Meeting Agent problem report · ' + app.getVersion())}&body=${encodeURIComponent(body)}`);
    return { ok: true, message: `The report is saved on your Desktop (${path.basename(file)}) and an email is open. Attach the file and send.` };
  }
  return { ok: true, message: `The report is saved on your Desktop (${path.basename(file)}). Send it to whoever looks after Meeting Agent.` };
}

export const openLogs = (): Promise<string> => shell.openPath(logsDir());
