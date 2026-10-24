export type FeedbackKind = 'idea' | 'bug' | 'praise' | 'question';

export const KIND_LABEL: Record<FeedbackKind, string> = {
  idea: 'Idea',
  bug: 'Something broke',
  praise: 'What I liked',
  question: 'Question'
};

export interface FeedbackEntry {
  id: string;
  date: string;
  kind: FeedbackKind;
  rating: number | null;
  message: string;
  anonymous: boolean;
  name: string;
  email: string;
  details: string;
  sentVia: 'online' | 'email' | 'github' | 'copied' | null;
}

export function makeEntry(input: {
  kind: FeedbackKind; rating: number | null; message: string; anonymous: boolean; name: string; email: string; details: string;
}): FeedbackEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    date: new Date().toISOString(),
    kind: input.kind,
    rating: input.rating,
    message: input.message.trim(),
    anonymous: input.anonymous,
    // An anonymous entry never carries a name or address, even if the boxes were filled in earlier.
    name: input.anonymous ? '' : input.name.trim(),
    email: input.anonymous ? '' : input.email.trim(),
    details: input.details,
    sentVia: null
  };
}

export function isValidEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(text.trim());
}

export function stars(rating: number | null): string {
  return rating && rating >= 1 && rating <= 5 ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '';
}

export function subject(entry: FeedbackEntry): string {
  const first = entry.message.split('\n')[0] ?? '';
  const short = first.length > 60 ? first.slice(0, 60) + '…' : first;
  return `Meeting Agent feedback · ${KIND_LABEL[entry.kind]}` + (short ? ` · ${short}` : '');
}

export function body(entry: FeedbackEntry): string {
  const lines = [`Type: ${KIND_LABEL[entry.kind]}`];
  if (stars(entry.rating)) lines.push(`Overall: ${stars(entry.rating)} (${entry.rating} of 5)`);
  lines.push('', entry.message, '', '—');
  if (entry.anonymous) lines.push('From: sent anonymously');
  else {
    lines.push(`From: ${entry.name || '(no name given)'}`);
    lines.push(`Reply to: ${entry.email || '(no email given)'}`);
  }
  if (entry.details) lines.push('', entry.details);
  return lines.join('\n');
}

export function mailtoUrl(to: string, entry: FeedbackEntry): string | null {
  if (!isValidEmail(to)) return null;
  return `mailto:${to}?subject=${encodeURIComponent(subject(entry))}&body=${encodeURIComponent(body(entry))}`;
}

export function githubUrl(repo: string, entry: FeedbackEntry): string {
  const labels: Partial<Record<FeedbackKind, string>> = { bug: 'bug', idea: 'enhancement', question: 'question' };
  const q = [`title=${encodeURIComponent(subject(entry))}`, `body=${encodeURIComponent(body(entry))}`];
  if (labels[entry.kind]) q.push(`labels=${labels[entry.kind]}`);
  return `https://github.com/${repo}/issues/new?${q.join('&')}`;
}

/** What is posted to an online form. Anonymous entries have no name or email in them at all. */
export function payload(entry: FeedbackEntry, app: string, version: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    kind: entry.kind, message: entry.message, anonymous: entry.anonymous, date: entry.date,
    app, version, details: entry.details, text: body(entry), subject: subject(entry)
  };
  if (entry.rating !== null) data.rating = entry.rating;
  if (!entry.anonymous) { data.name = entry.name; data.email = entry.email; }
  return data;
}
