import { CallRecord, SearchHit } from './types';
import { TLine, clock, seekTime } from './transcript';

export function tokens(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

export function matches(text: string, toks: string[]): boolean {
  const lower = text.toLowerCase();
  return toks.length > 0 && toks.every((t) => lower.includes(t));
}

export function snippet(text: string, toks: string[], radius = 70): string {
  const lower = text.toLowerCase();
  const at = toks.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + radius);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

export function search(query: string, calls: CallRecord[], transcripts: Map<string, TLine[]>): SearchHit[] {
  const toks = tokens(query);
  if (toks.length === 0 || query.trim().length < 2) return [];
  const hits: SearchHit[] = [];
  const when = (c: CallRecord) => new Date(c.startedAt).toLocaleString();

  for (const call of calls) {
    const hay = [call.title, call.project, call.summary].join('\n');
    if (matches(hay, toks)) {
      hits.push({ kind: 'call', callId: call.id, title: `${call.title} · ${when(call)}`, detail: matches(call.summary, toks) ? snippet(call.summary, toks) : call.project || call.app });
    }
  }
  let moments = 0;
  for (const call of [...calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    let perCall = 0;
    for (const line of transcripts.get(call.id) ?? []) {
      if (moments >= 14 || perCall >= 3) break;
      if (!matches(line.text, toks)) continue;
      perCall++;
      moments++;
      hits.push({
        kind: 'moment',
        callId: call.id,
        title: (line.speaker ? `${line.speaker}: ` : '') + snippet(line.text, toks, 80),
        detail: `${call.title} · ${when(call)}` + (line.time !== null ? ` · at ${clock(line.time)}` : ''),
        seek: seekTime(line) ?? undefined
      });
    }
  }
  for (const call of calls) {
    for (const p of call.promises) {
      if (hits.filter((h) => h.kind === 'promise').length >= 6) break;
      if (matches(`${p.text} ${p.owner}`, toks)) {
        hits.push({ kind: 'promise', callId: call.id, title: `${p.mine ? 'You' : p.owner}: ${p.text}`, detail: p.done ? 'Done' : 'Open' });
      }
    }
  }
  const order = { call: 0, moment: 1, promise: 2 } as const;
  return hits.sort((a, b) => order[a.kind] - order[b.kind]);
}
