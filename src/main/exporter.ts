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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** A clean printable page, used for the PDF export. */
export function html(call: CallRecord, lines: TLine[]): string {
  const bullets = (text: string) => text.split('\n').map((r) => r.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).map((r) => `<li>${esc(r).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:12.5px/1.55 "Segoe UI",system-ui,sans-serif;color:#15171f;margin:0;padding:8px 6px}
    h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#4d5efb;margin:22px 0 6px}
    .meta{color:#6a6f80}ul{padding-left:20px;margin:4px 0}.t{color:#4d5efb;font-variant-numeric:tabular-nums;margin-right:8px}
    .l{padding:2px 0}.done{text-decoration:line-through;color:#6a6f80}
  </style><h1>${esc(call.title)}</h1>
  <div class="meta">${esc(new Date(call.startedAt).toLocaleString())} · ${esc(call.app)}${call.project ? ' · ' + esc(call.project) : ''}</div>
  ${call.summary ? `<h2>Summary</h2><ul>${bullets(call.summary)}</ul>` : ''}
  ${call.decisions.length ? `<h2>Decisions</h2><ul>${call.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
  ${call.promises.length ? `<h2>Promises</h2><ul>${call.promises.map((p) => `<li class="${p.done ? 'done' : ''}"><b>${esc(p.mine ? 'You' : p.owner)}:</b> ${esc(p.text)}${p.due ? ` (due ${esc(p.due)})` : ''}</li>`).join('')}</ul>` : ''}
  ${lines.length ? `<h2>Transcript</h2>${lines.map((l) => `<div class="l"><span class="t">${l.time !== null ? clock(l.time) : ''}</span><b>${esc(l.speaker)}</b> ${esc(l.text)}</div>`).join('')}` : ''}`;
}
