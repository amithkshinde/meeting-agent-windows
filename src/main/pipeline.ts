import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError, complete, transcribe } from './ai';
import { makeSeekable, toOgg } from './media';
import * as store from './store';
import { loadKey } from './secrets';
import { merge, parse, format } from '../shared/transcript';
import { SUMMARY_SYSTEM, parseSummary, summaryPrompt, toCommitments, transcribePrompt } from '../shared/prompts';

type Progress = (message: string) => void;

/** After a call: fix the video, write the transcript, then the summary and promises. */
export async function processCall(id: string, progress: Progress): Promise<void> {
  const call = store.readCall(id);
  if (!call) return;
  const dir = store.folder(id);
  const settings = store.readSettings();
  call.status = 'processing';
  call.error = undefined;
  store.writeCall(call);

  try {
    progress('Preparing the video…');
    await makeSeekable(path.join(dir, 'screen.webm'));

    const key = loadKey();
    if (!key) throw new AIError('Add an AI key in Settings and I will write the transcript and summary.', 'key');

    progress('Writing the transcript…');
    const sets = [];
    for (const [file, kind] of [['system.webm', 'them'], ['mic.webm', 'you']] as const) {
      const ogg = await toOgg(path.join(dir, file));
      if (!ogg) continue;
      const text = await transcribe(key, ogg, transcribePrompt(kind, settings));
      sets.push(parse(text.replace(/```[a-z]*\n?/g, '')).filter((l) => l.time !== null));
    }
    const lines = merge(...sets);
    fs.writeFileSync(store.transcriptPath(id), lines.map(format).join('\n'));

    if (lines.length === 0) {
      call.status = 'done';
      call.summary = 'No speech was picked up in this recording.';
      store.writeCall(call);
      return;
    }

    progress('Writing the summary…');
    const raw = await complete(key, SUMMARY_SYSTEM, summaryPrompt(lines.map(format).join('\n'), store.readBookmarks(id), settings.userName), true, 4096);
    const parsed = parseSummary(raw);
    if (!parsed) throw new AIError('The summary came back in a shape I could not read. Use Retry.', 'other');
    call.title = parsed.title || call.title;
    call.summary = parsed.summary;
    call.decisions = parsed.decisions;
    call.promises = toCommitments(parsed.promises, settings.userName);
    if (!call.project) call.project = parsed.project;
    call.status = 'done';
    store.writeCall(call);
  } catch (error) {
    call.status = 'error';
    call.error = error instanceof Error ? error.message : String(error);
    store.writeCall(call);
  }
}
