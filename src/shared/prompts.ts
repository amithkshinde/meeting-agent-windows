import { Commitment, Settings } from './types';

type Lang = Pick<Settings, 'language' | 'script'>;

export function languageRule(s: Lang): string {
  switch (s.language) {
    case 'en': return 'Transcribe in English.';
    case 'hinglish': return 'The speakers mix Hindi and English. Write Hindi words in Roman letters (Hinglish) and keep English words as spoken.';
    case 'hi': return s.script === 'devanagari'
      ? 'The speakers speak Hindi. Write it in Devanagari script.'
      : 'The speakers speak Hindi. Write it in Roman letters (Hinglish), not Devanagari.';
    default: return s.script === 'devanagari'
      ? 'Transcribe in the language spoken. Write Hindi in Devanagari script.'
      : 'Transcribe in the language spoken. If it is Hindi or a Hindi and English mix, write the Hindi in Roman letters (Hinglish), not Devanagari.';
  }
}

export function transcribePrompt(kind: 'them' | 'you', s: Lang): string {
  const who = kind === 'you'
    ? "Use the speaker label 'You' for every line."
    : "Use 'Speaker 1', 'Speaker 2' and so on for different voices, keeping the same number for the same voice.";
  return [
    'Transcribe this call recording.',
    'Output ONLY lines in exactly this format, one per utterance, in order:',
    '[mm:ss] Speaker: text',
    'mm:ss is when the utterance STARTS, counted from the start of the recording (use h:mm:ss after the first hour).',
    who,
    languageRule(s),
    'Skip silence and background noise. Do not add commentary, headings or markdown. If there is no speech, output nothing.'
  ].join('\n');
}

export const SUMMARY_SYSTEM =
  'You write concise, factual call notes for a busy professional. Never invent facts. ' +
  'Return ONLY JSON, with no markdown fence, in this shape: ' +
  '{"title": string (at most 8 words), "summary": string (5 to 10 short markdown bullet lines, most important first), ' +
  '"decisions": string[], "promises": [{"owner": string, "text": string, "due": string or null}], "project": string or null}. ' +
  'A promise is an explicit commitment someone made to do something. Use the speaker name as the owner. Leave the list empty if there are none.';

export function summaryPrompt(transcript: string, bookmarks: { t: number; note: string }[], userName: string): string {
  const marks = bookmarks.length
    ? `\nThe user marked these moments as important (seconds from the start): ${bookmarks.map((b) => b.t).join(', ')}.\n`
    : '';
  return `The person taking these notes is "${userName}", labelled "You" in the transcript.${marks}\nTranscript:\n${transcript.slice(0, 120000)}`;
}

export interface ParsedSummary {
  title: string;
  summary: string;
  decisions: string[];
  promises: { owner: string; text: string; due?: string }[];
  project: string;
}

/** Models sometimes wrap JSON in a fence or add a sentence around it. Pull the object out. */
export function parseSummary(raw: string): ParsedSummary | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const promises = Array.isArray(data.promises)
      ? (data.promises as Record<string, unknown>[])
          .filter((p) => typeof p?.text === 'string')
          .map((p) => ({ owner: String(p.owner ?? ''), text: String(p.text), due: typeof p.due === 'string' && p.due ? p.due : undefined }))
      : [];
    return {
      title: typeof data.title === 'string' ? data.title : '',
      summary: typeof data.summary === 'string' ? data.summary : '',
      decisions: strings(data.decisions),
      promises,
      project: typeof data.project === 'string' ? data.project : ''
    };
  } catch {
    return null;
  }
}

export function toCommitments(list: ParsedSummary['promises'], userName: string): Commitment[] {
  const me = userName.trim().toLowerCase();
  return list.map((p, i) => {
    const owner = p.owner.trim() || 'Someone';
    const lower = owner.toLowerCase();
    return {
      id: `${Date.now().toString(36)}-${i}`,
      owner,
      text: p.text,
      due: p.due,
      done: false,
      mine: lower === 'you' || (me.length > 0 && (lower === me || lower.split(' ')[0] === me.split(' ')[0]))
    };
  });
}
