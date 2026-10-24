import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

function ffmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    return p ? p.replace('app.asar', 'app.asar.unpacked') : null;
  } catch {
    return null;
  }
}

function run(args: string[]): Promise<boolean> {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(bin, ['-y', '-loglevel', 'error', ...args], { windowsHide: true, timeout: 10 * 60 * 1000 }, (error) => resolve(!error));
  });
}

/**
 * The browser writes video without a length or seek table, so clicking a transcript line would not jump.
 * Copying the streams into a fresh file (no re-encoding, takes seconds) fixes that.
 */
export async function makeSeekable(file: string): Promise<boolean> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return false;
  const fixed = file.replace(/\.webm$/, '.fixed.webm');
  if (!(await run(['-i', file, '-c', 'copy', fixed]))) return false;
  fs.renameSync(fixed, file);
  return true;
}

/** Gemini does not take WebM audio, but it does take Ogg. The sound is Opus either way, so this is a copy. */
export async function toOgg(file: string): Promise<string | null> {
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) return null;
  const out = file.replace(/\.webm$/, '.ogg');
  return (await run(['-i', file, '-vn', '-c:a', 'copy', out])) ? out : null;
}
