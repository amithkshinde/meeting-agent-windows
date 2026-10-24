import { CallRecord } from '../shared/types';
import { TLine, clock } from '../shared/transcript';

export function markdown(call: CallRecord, lines: TLine[]): string {
  const out: string[] = [`# ${call.title}`, '', `${new Date(call.startedAt).toLocaleString()} · ${call.app}` + (call.project ? ` · ${call.project}` : ''), ''];
  if (call.summary) out.push('## Summary', '', call.summary, '');
  if (call.decisions.length) out.push('## Decisions', '', ...call.decisions.map((d) => `- ${d}`), '');
  if (call.promises.length) {
    out.push('## Promises', '');
    for (const p of call.promises) out.push(`- [${p.done ? 'x' : ' '}] **${p.mine ? 'You' : p.owner}:** ${p.text}${p.due ? ` (due ${p.due})` : ''}`);
    out.push('');
  }
  if (lines.length) {
    out.push('## Transcript', '');
    for (const l of lines) out.push((l.time !== null ? `**[${clock(l.time)}]** ` : '') + (l.speaker ? `${l.speaker}: ` : '') + l.text, '');
  }
  return out.join('\n');
}

export function fileName(call: CallRecord, ext: string): string {
  const safe = call.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'call';
  return `${call.startedAt.slice(0, 10)}-${safe}.${ext}`;
}
