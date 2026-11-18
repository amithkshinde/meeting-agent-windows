import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError, complete, transcribe } from './ai';
import { decodeTo16k, makeSeekable, toOgg } from './media';
import { log } from './log';
import * as parakeet from './parakeet';
import * as store from './store';
import { loadKey } from './secrets';
import { isClaudeKey } from './ai';
import { TLine, merge, parse, format } from '../shared/transcript';
import { removeEchoes, toLines, Utterance } from '../shared/speech';
import { SUMMARY_SYSTEM, parseSummary, summaryPrompt, toCommitments, transcribePrompt } from '../shared/prompts';

type Progress = (message: string) => void;

/** Hindi and Hinglish are not supported by Parakeet, so those go to Gemini when a Gemini key is saved. */
async function transcribeWithGemini(dir: string, key: string, settings: ReturnType<typeof store.readSettings>, progress: Progress): Promise<TLine[]> {
  progress('Writing the transcript…');
  const sets: TLine[][] = [];
  for (const [file, kind] of [['system.webm', 'them'], ['mic.webm', 'you']] as const) {
    const ogg = await toOgg(path.join(dir, file));
    if (!ogg) continue;
    const text = await transcribe(key, ogg, transcribePrompt(kind, settings));
    sets.push(parse(text.replace(/```[a-z]*\n?/g, '')).filter((l) => l.time !== null));
  }
  return merge(...sets);
}

/** Parakeet runs on this PC, so call audio stays here. */
async function transcribeWithParakeet(id: string, dir: string, progress: Progress): Promise<TLine[]> {
  const heard: Record<string, Utterance[]> = {};
  for (const [file, key, label] of [['system.webm', 'system', 'Them'], ['mic.webm', 'mic', 'You']] as const) {
    progress(parakeet.isInstalled() ? 'Writing the transcript…' : 'Getting the speech model ready (first time only, about 650 MB)…');
    const samples = await decodeTo16k(path.join(dir, file));
    if (!samples) { log.warn('pipeline', `No usable audio in ${file} for ${id}`); heard[key] = []; continue; }
    heard[key] = await parakeet.transcribe(samples, (fraction) => progress(`Writing the transcript (${label}) ${Math.round(fraction * 100)}%`));
  }
  const you = removeEchoes(heard.mic ?? [], heard.system ?? []);
  return merge(toLines(heard.system ?? [], 'Them'), toLines(you, 'You'));
}

/** After a call: fix the video, write the transcript, then (if there is an AI key) the summary and promises. */
export async function processCall(id: string, progress: Progress): Promise<void> {
  const call = store.readCall(id);
  if (!call) return;
  const dir = store.folder(id);
  const settings = store.readSettings();
  call.status = 'processing';
  call.error = undefined;
  store.writeCall(call);
  const started = Date.now();

  try {
    progress('Preparing the video…');
    await makeSeekable(path.join(dir, 'screen.webm'));

    const key = loadKey();
    const geminiKey = key && !isClaudeKey(key) ? key : null;
    const wantsGemini = settings.language === 'hi' || settings.language === 'hinglish';
    let lines: TLine[];
    if (wantsGemini && geminiKey) {
      log.info('pipeline', `Transcribing ${id} with Gemini (${settings.language} is not supported by Parakeet)`);
      lines = await transcribeWithGemini(dir, geminiKey, settings, progress);
    } else {
      if (wantsGemini) log.warn('pipeline', `Language is ${settings.language} but no Gemini key is saved, so Parakeet (English) is used`);
      try {
        lines = await transcribeWithParakeet(id, dir, progress);
      } catch (error) {
        if (!geminiKey) throw error;
        log.warn('pipeline', `Parakeet failed (${(error as Error).message}); using Gemini instead`);
        lines = await transcribeWithGemini(dir, geminiKey, settings, progress);
      }
    }
    fs.writeFileSync(store.transcriptPath(id), lines.map(format).join('\n'));
    log.info('pipeline', `Transcript for ${id}: ${lines.length} lines in ${Math.round((Date.now() - started) / 1000)} s`);

    if (lines.length === 0) {
      call.status = 'done';
      call.summary = 'No speech was picked up in this recording.';
      store.writeCall(call);
      return;
    }

    if (!key) {
      call.status = 'done';
      call.summary = 'The transcript is ready. Add an AI key in Settings to get a summary and a list of promises.';
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
    const message = error instanceof Error ? error.message : String(error);
    log.error('pipeline', `Processing ${id} failed: ${message}`);
    call.status = 'error';
    call.error = message;
    store.writeCall(call);
  }
}
