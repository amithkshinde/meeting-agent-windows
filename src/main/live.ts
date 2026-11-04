import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError, complete, transcribe } from './ai';
import { toOgg } from './media';
import { loadKey } from './secrets';
import * as store from './store';
import { LIVE_SYSTEM, livePrompt, memoryNotes, offsetLines, parseLive } from '../shared/live';
import { TLine, merge, parse } from '../shared/transcript';
import { transcribePrompt } from '../shared/prompts';

// Live captions and suggestions while a call is being recorded. The panel cuts the other people's sound into
// short standalone pieces; each piece is written out here, then the suggestions are refreshed from the new words.

type Emit = (channel: string, ...args: unknown[]) => void;

let lines: TLine[] = [];
let busy = false;
let counter = 0;
let notes = '';

export function reset(): void {
  lines = [];
  busy = false;
  counter = 0;
  notes = memoryNotes(store.listCalls(), '');
}

export async function chunk(data: ArrayBuffer, offsetSec: number, emit: Emit): Promise<void> {
  const settings = store.readSettings();
  if (!settings.liveCaptions) return;
  if (busy) { emit('live:note', 'Catching up…'); return; }
  const key = loadKey();
  if (!key) { emit('live:note', 'Add an AI key in Settings to see live captions.'); return; }

  busy = true;
  const dir = path.join(store.root(), '.live');
  fs.mkdirSync(dir, { recursive: true });
  const webm = path.join(dir, `chunk-${Date.now()}-${counter++}.webm`);
  const made: string[] = [webm];
  try {
    fs.writeFileSync(webm, Buffer.from(data));
    const ogg = await toOgg(webm);
    if (!ogg) { emit('live:note', 'That piece of sound was too short to write down.'); return; }
    made.push(ogg);
    const text = await transcribe(key, ogg, transcribePrompt('them', settings));
    const fresh = offsetLines(parse(text.replace(/```[a-z]*\n?/g, '')), offsetSec);
    if (!fresh.length) { emit('live:note', ''); return; }
    lines = merge(lines, fresh);
    emit('live:lines', fresh);
    emit('live:note', '');

    if (settings.copilot) {
      try {
        const raw = await complete(key, LIVE_SYSTEM, livePrompt(lines, notes, settings.userName), true, 1024);
        const insight = parseLive(raw);
        if (insight) emit('live:insight', insight);
      } catch (error) {
        // The captions still worked; only the suggestions are missing this round.
        if (error instanceof AIError && error.kind !== 'other') emit('live:note', error.message);
      }
    }
  } catch (error) {
    emit('live:note', error instanceof AIError ? error.message : 'Live captions hit a snag and will try again.');
  } finally {
    busy = false;
    for (const f of made) fs.rm(f, { force: true }, () => undefined);
  }
}

/** Whatever was written live, in case the call is stopped before the full transcript is ready. */
export function current(): TLine[] {
  return lines;
}
