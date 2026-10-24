/** One line of a transcript: "[mm:ss] Speaker: text". Stamps are the START of the utterance. */
export interface TLine {
  id: number;
  time: number | null;   // seconds, or null if the line has no stamp
  speaker: string;
  text: string;
}

export function secondsFrom(stamp: string): number | null {
  const parts = stamp.split(':').map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export function parseLine(row: string, id: number): TLine {
  const match = /^\[([0-9:]+)\]\s*(.*)$/.exec(row);
  if (!match) return { id, time: null, speaker: '', text: row };
  const time = secondsFrom(match[1]);
  const rest = match[2];
  const colon = rest.indexOf(': ');
  if (colon > 0 && colon <= 40) {
    return { id, time, speaker: rest.slice(0, colon), text: rest.slice(colon + 2) };
  }
  return { id, time, speaker: '', text: rest };
}

export function parse(raw: string): TLine[] {
  const lines: TLine[] = [];
  raw.split('\n').forEach((row, index) => {
    const trimmed = row.trim();
    if (trimmed) lines.push(parseLine(trimmed, index));
  });
  return lines;
}

export function format(line: TLine): string {
  if (line.time === null) return line.text;
  const total = Math.max(0, Math.floor(line.time));
  const stamp = `[${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}] `;
  return line.speaker ? `${stamp}${line.speaker}: ${line.text}` : stamp + line.text;
}

/** Where in the video to start when a line is clicked: a moment before the line starts. */
export function seekTime(line: TLine): number | null {
  return line.time === null ? null : Math.max(0, line.time - 2);
}

/** Index of the line being spoken at `time`: the last line that starts no later than it. */
export function currentIndex(lines: TLine[], time: number): number | null {
  let found: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].time;
    if (t === null) continue;
    if (t <= time + 0.5) found = i;
    else break;
  }
  return found;
}

/** Joins the two recordings into one conversation, in time order. */
export function merge(...sets: TLine[][]): TLine[] {
  const all = sets.flat();
  return all
    .map((line, order) => ({ line, order }))
    .sort((a, b) => ((a.line.time ?? 0) - (b.line.time ?? 0)) || a.order - b.order)
    .map((entry, index) => ({ ...entry.line, id: index }));
}

export function speakers(lines: TLine[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) if (l.speaker) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
}

export function rename(raw: string, from: string, to: string): string {
  return raw
    .split('\n')
    .map((row) => {
      const line = parseLine(row.trim(), 0);
      if (line.time === null || line.speaker !== from) return row;
      return format({ ...line, speaker: to });
    })
    .join('\n');
}
