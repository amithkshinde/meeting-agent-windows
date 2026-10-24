import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CallDebouncer, matchCall, parseWindowList } from '../shared/detect';
import * as T from '../shared/transcript';
import * as F from '../shared/feedback';
import { parseSummary, toCommitments, transcribePrompt } from '../shared/prompts';
import { search } from '../shared/search';
import { CallRecord } from '../shared/types';

test('detects Google Meet in a browser tab', () => {
  const hit = matchCall([{ process: 'chrome', title: 'Meet - abc-defg-hij - Google Chrome' }]);
  assert.equal(hit?.app, 'Google Meet');
  assert.equal(hit?.title, 'Meet - abc-defg-hij');
  assert.equal(matchCall([{ process: 'chrome', title: 'Meet - Google Meet landing' }]), null);
  assert.equal(matchCall([{ process: 'notepad', title: 'Meet - abc-defg-hij' }]), null);
});

test('detects Zoom and Teams meetings, not the idle apps', () => {
  assert.equal(matchCall([{ process: 'Zoom', title: 'Zoom Meeting' }])?.app, 'Zoom');
  assert.equal(matchCall([{ process: 'Zoom', title: 'Zoom Workplace' }]), null);
  assert.equal(matchCall([{ process: 'ms-teams', title: 'Meeting with Priya | Microsoft Teams' }])?.app, 'Microsoft Teams');
  assert.equal(matchCall([{ process: 'ms-teams', title: 'Chat | Microsoft Teams' }]), null);
});

test('window list parsing keeps pipes inside titles', () => {
  const rows = parseWindowList('chrome|Meet - abc-defg-hij - Google Chrome\r\nnotepad|a | b\r\n|empty\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].title, 'a | b');
});

test('debouncer starts after 2 hits and ends after 4 misses', () => {
  const d = new CallDebouncer();
  const call = { app: 'Zoom', title: 'Zoom meeting' };
  assert.deepEqual(d.feed(call), {});
  assert.equal(d.feed(call).started?.app, 'Zoom');
  for (let i = 0; i < 3; i++) assert.deepEqual(d.feed(null), {});
  assert.equal(d.feed(null).ended?.app, 'Zoom');
  assert.deepEqual(d.feed(call), {});          // a flicker alone does nothing
});

test('transcript parse, format, merge, rename, seek', () => {
  const lines = T.parse('[00:05] You: hello there\n[01:10] Speaker 1: sounds good: really\nplain');
  assert.equal(lines.length, 3);
  assert.equal(lines[1].time, 70);
  assert.equal(lines[1].text, 'sounds good: really');
  assert.equal(T.format(lines[0]), '[00:05] You: hello there');
  assert.equal(T.seekTime(lines[0]), 3);
  assert.equal(T.currentIndex(lines, 69), 0);
  assert.equal(T.currentIndex(lines, 71), 1);
  const merged = T.merge(T.parse('[00:10] You: b'), T.parse('[00:02] Speaker 1: a\n[00:30] Speaker 1: c'));
  assert.deepEqual(merged.map((l) => l.text), ['a', 'b', 'c']);
  const renamed = T.rename('[00:02] Speaker 1: a\n[00:03] You: b', 'Speaker 1', 'Priya');
  assert.equal(renamed.split('\n')[0], '[00:02] Priya: a');
  assert.equal(T.clock(3725), '1:02:05');
});

test('feedback: anonymous entries carry nothing identifying', () => {
  const anon = F.makeEntry({ kind: 'bug', rating: 4, message: 'It broke & burned + more', anonymous: true, name: 'Sam', email: 'sam@x.com', details: 'App 0.1' });
  assert.equal(anon.name, '');
  assert.equal(anon.email, '');
  assert.ok(!F.body(anon).includes('sam@x.com'));
  assert.ok(F.body(anon).includes('sent anonymously'));
  const p = F.payload(anon, 'MA', '1');
  assert.ok(!('name' in p) && !('email' in p));
  const named = F.makeEntry({ kind: 'idea', rating: null, message: 'Dark mode', anonymous: false, name: 'Sam', email: 'sam@x.com', details: '' });
  assert.ok(F.body(named).includes('Reply to: sam@x.com'));
  assert.equal((F.payload(named, 'MA', '1') as { email: string }).email, 'sam@x.com');
  assert.ok(F.mailtoUrl('me@x.com', anon)!.includes('%26'));
  assert.equal(F.mailtoUrl('', anon), null);
  assert.ok(F.githubUrl('a/b', named).includes('labels=enhancement'));
  assert.ok(F.isValidEmail('a@b.co') && !F.isValidEmail('a@b') && !F.isValidEmail('a b@c.com'));
});

test('summary parsing tolerates fences and extra text; promises know whose they are', () => {
  const raw = 'Sure!\n```json\n{"title":"Kickoff","summary":"- one\\n- two","decisions":["Go"],"promises":[{"owner":"Amith K","text":"Send deck","due":"Friday"},{"owner":"Priya","text":"Share logo","due":null}],"project":null}\n```';
  const s = parseSummary(raw)!;
  assert.equal(s.title, 'Kickoff');
  assert.equal(s.promises.length, 2);
  const c = toCommitments(s.promises, 'Amith');
  assert.equal(c[0].mine, true);
  assert.equal(c[1].mine, false);
  assert.equal(parseSummary('no json here'), null);
});

test('language rules reach the transcription prompt', () => {
  assert.ok(transcribePrompt('them', { language: 'hinglish', script: 'roman' }).includes('Hinglish'));
  assert.ok(transcribePrompt('you', { language: 'hi', script: 'devanagari' }).includes('Devanagari'));
  assert.ok(transcribePrompt('you', { language: 'en', script: 'roman' }).includes("'You'"));
});

test('search finds moments and promises across calls', () => {
  const call: CallRecord = { id: 'c1', startedAt: '2026-10-01T10:00:00Z', durationSec: 60, app: 'Zoom', title: 'Pricing sync', project: 'Acme', status: 'done', summary: '- discussed pricing tiers', decisions: [], promises: [{ id: 'p', owner: 'Priya', text: 'Send pricing sheet', done: false, mine: false }] };
  const transcripts = new Map([['c1', T.parse('[00:30] Speaker 1: the pricing is too high')]]);
  const hits = search('pricing', [call], transcripts);
  assert.deepEqual(hits.map((h) => h.kind), ['call', 'moment', 'promise']);
  assert.equal(hits[1].seek, 28);
  assert.equal(search('x', [call], transcripts).length, 0);
});

test('store: create, list, bookmark, settings', () => {
  process.env.MEETING_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const store = require('../main/store') as typeof import('../main/store');
  const a = store.newCall('Zoom', 'Standup', new Date('2026-10-01T09:30:00'));
  const b = store.newCall('Zoom', 'Standup', new Date('2026-10-01T09:30:00'));
  assert.notEqual(a.id, b.id);
  assert.equal(store.listCalls().length, 2);
  store.addBookmark(a.id, 30);
  store.addBookmark(a.id, 10);
  assert.deepEqual(store.readBookmarks(a.id).map((x) => x.t), [10, 30]);
  store.writeSettings({ language: 'hinglish' });
  assert.equal(store.readSettings().language, 'hinglish');
});
