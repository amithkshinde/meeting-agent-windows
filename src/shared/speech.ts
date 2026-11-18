import { TLine } from './transcript';

/** One word piece from the speech engine, in seconds. A piece that starts a word begins with a space. */
export interface Token { text: string; start: number; end: number }
export interface Utterance { start: number; end: number; text: string }

/** Groups word pieces into sentences: a new one starts after a pause, after . ? ! or when it gets long. */
export function utterances(tokens: Token[], pause = 1.2, longest = 20): Utterance[] {
  const out: Utterance[] = [];
  let text = '';
  let start: number | null = null;
  let end = 0;
  const flush = () => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (start !== null && cleaned) out.push({ start, end: Math.max(end, start), text: cleaned });
    text = '';
    start = null;
  };
  for (const token of tokens) {
    const startsWord = token.text.startsWith(' ') || token.text.startsWith('▁');
    if (start !== null) {
      const gap = token.start - end;
      const length = token.end - start;
      const endsSentence = /[.?!]$/.test(text);
      if (startsWord && (gap > pause || length > longest || endsSentence)) flush();
    }
    if (start === null) start = token.start;
    text += token.text.replace(/▁/g, ' ');
    end = token.end;
  }
  flush();
  return out;
}

/**
 * Cuts long audio into pieces of about `target` seconds, always at the quietest moment near the cut,
 * so a word is not sliced in half. Returns [startSample, endSample] pairs.
 */
export function splitAtSilence(samples: Float32Array, sampleRate: number, target = 25, longest = 35): [number, number][] {
  const total = samples.length;
  const maxLen = Math.floor(longest * sampleRate);
  if (total <= maxLen) return total > 0 ? [[0, total]] : [];
  const window = Math.floor(0.1 * sampleRate);
  const pieces: [number, number][] = [];
  let from = 0;
  while (total - from > maxLen) {
    const searchStart = from + Math.floor((target - 5) * sampleRate);
    const searchEnd = Math.min(from + maxLen, total);
    let best = searchStart;
    let bestEnergy = Infinity;
    for (let at = searchStart; at + window <= searchEnd; at += window) {
      let energy = 0;
      for (let i = at; i < at + window; i += 8) energy += samples[i] * samples[i];
      if (energy < bestEnergy) { bestEnergy = energy; best = at + Math.floor(window / 2); }
    }
    pieces.push([from, best]);
    from = best;
  }
  pieces.push([from, total]);
  return pieces;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  const smaller = Math.min(wa.size, wb.size);
  if (smaller < 3) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / smaller;
}

/**
 * Drops "You" sentences that are only the call audio leaking into the microphone (no headphones).
 * The leak arrives a little late and is often cut into different sentences, so a mic sentence is an echo
 * when nearly all its words (at least 3) appear in what the other people said in the 10 seconds around it.
 */
export function removeEchoes(you: Utterance[], them: Utterance[]): Utterance[] {
  const list = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return you.filter((mine) => {
    const mineWords = list(mine.text);
    if (mineWords.length < 3) return true;
    const nearby = new Set<string>();
    for (const theirs of them) {
      if (theirs.start - 10 <= mine.end && theirs.end + 10 >= mine.start) list(theirs.text).forEach((w) => nearby.add(w));
    }
    if (nearby.size === 0) return true;
    return mineWords.filter((w) => nearby.has(w)).length / mineWords.length < 0.8;
  });
}

export function toLines(items: Utterance[], speaker: string): TLine[] {
  return items.map((u, id) => ({ id, time: u.start, speaker, text: u.text }));
}
