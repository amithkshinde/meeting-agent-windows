import { CallRecord } from './types';
import { TLine, clock, format } from './transcript';
import { matches, tokens } from './search';

// Live help during a call, projects, and "ask about everything". Pure functions so they can be tested.

export interface Suggestion {
  kind: 'ask' | 'pushback' | 'flag';
  text: string;
  why: string;
}

export interface LiveInsight {
  recap: string[];
  suggestions: Suggestion[];
}

export const LIVE_SYSTEM =
  'You are a quiet copilot sitting beside a professional during a live call. You are given what was just said, ' +
  'plus notes from their earlier calls. Help them answer well. Never invent facts: only use what is in the notes or the transcript. ' +
  'Return ONLY JSON, no markdown fence, in this shape: ' +
  '{"recap": string[] (at most 3 very short bullets of the most recent points), ' +
  '"suggestions": [{"kind": "ask" | "pushback" | "flag", "text": string (one sentence the person could say or do), "why": string (the earlier call or promise it comes from)}]}. ' +
  '"ask" is a good question to ask now, "pushback" is a polite way to hold a position using earlier agreements, "flag" is a risk or a contradiction with something said earlier. ' +
  'Give at most 2 suggestions, and none if nothing useful stands out. Keep every string under 160 characters.';

/** Short notes from earlier calls, newest first, preferring the same project. */
export function memoryNotes(calls: CallRecord[], project: string, limit = 6): string {
  const same = (c: CallRecord) => !!project && c.project.toLowerCase() === project.toLowerCase();
  const done = calls.filter((c) => c.status === 'done' && c.summary);
  const ordered = [...done.filter(same), ...done.filter((c) => !same(c))].slice(0, limit);
  return ordered
    .map((c) => {
      const open = c.promises.filter((p) => !p.done).map((p) => `${p.mine ? 'You' : p.owner}: ${p.text}${p.due ? ` (${p.due})` : ''}`);
      return [
        `# ${c.title} (${new Date(c.startedAt).toLocaleDateString()}${c.project ? `, project ${c.project}` : ''})`,
        c.summary.slice(0, 700),
        c.decisions.length ? `Decisions: ${c.decisions.join('; ').slice(0, 300)}` : '',
        open.length ? `Open promises: ${open.join('; ').slice(0, 300)}` : ''
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export function livePrompt(lines: TLine[], notes: string, userName: string, windowLines = 24): string {
  const recent = lines.slice(-windowLines).map(format).join('\n');
  return `The person is "${userName}", shown as "You" in the transcript.\n\nEarlier calls:\n${notes || '(none yet)'}\n\nWhat was just said:\n${recent}`;
}

export function parseLive(raw: string): LiveInsight | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const recap = Array.isArray(data.recap) ? data.recap.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 3) : [];
    const kinds = ['ask', 'pushback', 'flag'];
    const suggestions = Array.isArray(data.suggestions)
      ? (data.suggestions as Record<string, unknown>[])
          .filter((s) => typeof s?.text === 'string' && (s.text as string).trim().length > 0)
          .map((s) => ({
            kind: (kinds.includes(String(s.kind)) ? String(s.kind) : 'ask') as Suggestion['kind'],
            text: String(s.text).trim(),
            why: typeof s.why === 'string' ? s.why.trim() : ''
          }))
          .slice(0, 2)
      : [];
    return { recap, suggestions };
  } catch {
    return null;
  }
}

/** Shifts the times of a chunk that started `offset` seconds into the call, and drops empty lines. */
export function offsetLines(lines: TLine[], offset: number): TLine[] {
  return lines
    .filter((l) => l.time !== null && l.text.trim() && !/^(speaker \d+|you):?$/i.test(l.text.trim()))
    .map((l) => ({ ...l, time: (l.time as number) + offset }));
}

// MARK: projects

export interface Project {
  name: string;
  calls: CallRecord[];
  open: number;
  lastAt: string;
}

export function projectsOf(calls: CallRecord[]): { projects: Project[]; loose: CallRecord[] } {
  const map = new Map<string, Project>();
  const loose: CallRecord[] = [];
  for (const c of calls) {
    const name = c.project.trim();
    if (!name) { loose.push(c); continue; }
    const key = name.toLowerCase();
    const entry = map.get(key) ?? { name, calls: [], open: 0, lastAt: c.startedAt };
    entry.calls.push(c);
    entry.open += c.promises.filter((p) => !p.done).length;
    if (c.startedAt > entry.lastAt) entry.lastAt = c.startedAt;
    map.set(key, entry);
  }
  return { projects: [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), loose };
}

// MARK: ask about everything

export const CHAT_SYSTEM =
  'You answer questions about the user\'s own recorded calls, using ONLY the call notes and transcript excerpts you are given. ' +
  'Name the call and date when you cite something. If the answer is not in the material, say you could not find it. ' +
  'Be brief and concrete. Use short markdown bullets when listing.';

/** Picks the material worth sending: summaries of the scoped calls, plus transcript lines that match the question. */
export function chatContext(question: string, calls: CallRecord[], transcripts: Map<string, TLine[]>, project = ''): string {
  const scoped = project ? calls.filter((c) => c.project.toLowerCase() === project.toLowerCase()) : calls;
  const toks = tokens(question).filter((t) => t.length > 2);
  const parts: string[] = [];
  for (const c of scoped.slice(0, 25)) {
    const open = c.promises.map((p) => `${p.done ? '[done]' : '[open]'} ${p.mine ? 'You' : p.owner}: ${p.text}${p.due ? ` (${p.due})` : ''}`);
    parts.push([
      `## ${c.title} (${new Date(c.startedAt).toLocaleDateString()}, ${c.app}${c.project ? `, project ${c.project}` : ''})`,
      c.summary.slice(0, 900),
      c.decisions.length ? `Decisions: ${c.decisions.join('; ')}` : '',
      open.length ? `Promises: ${open.join('; ')}` : ''
    ].filter(Boolean).join('\n'));
  }
  const excerpts: string[] = [];
  for (const c of scoped) {
    let n = 0;
    for (const l of transcripts.get(c.id) ?? []) {
      if (n >= 6 || excerpts.length >= 40) break;
      if (toks.length && toks.some((t) => matches(l.text, [t]))) {
        n++;
        excerpts.push(`${c.title} @${l.time === null ? '?' : clock(l.time)} ${l.speaker ? l.speaker + ': ' : ''}${l.text}`);
      }
    }
  }
  const body = parts.join('\n\n') + (excerpts.length ? `\n\nTranscript excerpts that mention the question's words:\n${excerpts.join('\n')}` : '');
  return body.slice(0, 60000);
}

export function chatPrompt(question: string, context: string): string {
  return `Call material:\n${context || '(no calls recorded yet)'}\n\nQuestion: ${question}`;
}
