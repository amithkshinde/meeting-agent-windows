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

// MARK: reliability, speech and updates (0.2.0)

import { redact, formatLine, failures, closeOpen, ledgerReport, shouldResume, diskVerdict, LedgerEntry } from '../shared/logcore';
import { utterances, splitAtSilence, removeEchoes, toLines } from '../shared/speech';
import { isNewer, compareVersions, parseRelease, pickInstaller, headline, shouldRemind } from '../shared/update';

test('log lines never carry keys, emails or the account name', () => {
  assert.ok(redact('key AIzaSyA1234567890abcdefghijkl end').includes('[key]'));
  assert.ok(!redact('mail amith@example.com now').includes('@'));
  assert.equal(redact('C:\\Users\\amith\\Videos\\x'), 'C:\\Users\\~\\Videos\\x');
  const line = formatLine('warn', 'recorder', 'two\nlines');
  assert.ok(line.includes('WARN ') && line.includes('[recorder]') && line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
});

test('the ledger separates normal endings from failures', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const entries: LedgerEntry[] = [
    { id: 'a', app: 'Google Meet', startedAt: '2026-11-17T10:00:00Z', endedAt: '2026-11-17T10:30:00Z', automatic: false, reason: 'manualStop' },
    { id: 'b', app: 'Zoom', startedAt: '2026-11-16T10:00:00Z', endedAt: '2026-11-16T10:20:00Z', automatic: false, reason: 'captureEnded' },
    { id: 'c', app: 'Zoom', startedAt: '2026-11-15T10:00:00Z', automatic: false }
  ];
  assert.equal(failures(entries, 7, now).length, 1);
  const closed = closeOpen(entries, new Date(now));
  assert.equal(closed[2].reason, 'crashed');
  assert.equal(failures(closed, 7, now).length, 2);
  assert.ok(ledgerReport(closed, now).includes('2 ended unexpectedly'));
});

test('restart only after interruptions, and only a few times', () => {
  assert.equal(shouldResume('captureEnded', 0, true), true);
  assert.equal(shouldResume('captureEnded', 3, true), false);
  assert.equal(shouldResume('captureEnded', 0, false), false);
  assert.equal(shouldResume('sleep', 0, true), false);
  assert.equal(shouldResume('manualStop', 0, true), false);
});

test('disk space verdicts', () => {
  assert.equal(diskVerdict(500_000_000), 'critical');
  assert.equal(diskVerdict(2_000_000_000), 'low');
  assert.equal(diskVerdict(50_000_000_000), 'fine');
  assert.equal(diskVerdict(null), 'fine');
});

test('word pieces become sentences with start times', () => {
  const tokens = [
    { text: ' Hello', start: 0, end: 0.4 }, { text: ' the', start: 0.5, end: 0.7 }, { text: 're', start: 0.7, end: 0.9 }, { text: '.', start: 0.9, end: 1 },
    { text: ' How', start: 1.1, end: 1.3 }, { text: ' are', start: 1.3, end: 1.5 }, { text: ' you', start: 1.5, end: 1.8 }, { text: '?', start: 1.8, end: 1.9 },
    { text: ' Fine', start: 5, end: 5.4 }
  ];
  const u = utterances(tokens);
  assert.deepEqual(u.map((x) => x.text), ['Hello there.', 'How are you?', 'Fine']);
  assert.equal(u[2].start, 5);
});

test('long audio is cut at the quietest moment, not mid-word', () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 70).fill(0.2);
  samples.fill(0, rate * 27, rate * 28);          // a pause near the 27 second mark
  const pieces = splitAtSilence(samples, rate);
  assert.ok(pieces.length >= 2);
  assert.ok(pieces[0][1] >= rate * 27 && pieces[0][1] <= rate * 28, `cut at ${pieces[0][1] / rate}s`);
  assert.equal(pieces[pieces.length - 1][1], samples.length);
  assert.deepEqual(splitAtSilence(new Float32Array(rate * 10), rate), [[0, rate * 10]]);
});

test('microphone echo of the call is dropped, real replies are kept', () => {
  const them = [{ start: 10, end: 14, text: 'We should ship the release on Friday afternoon' }];
  const you = [{ start: 10.5, end: 14, text: 'we should ship the release on friday afternoon' }, { start: 20, end: 22, text: 'Sounds good to me' }];
  const kept = removeEchoes(you, them);
  assert.deepEqual(kept.map((x) => x.text), ['Sounds good to me']);
  const merged = T.merge(toLines(them, 'Them'), toLines(kept, 'You')).map(T.format);
  assert.deepEqual(merged, ['[00:10] Them: We should ship the release on Friday afternoon', '[00:20] You: Sounds good to me']);
});

test('update check: versions, releases and the right installer', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(isNewer('v0.3.0', '0.2.0'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('weird', '0.2.0'), false);
  const release = parseRelease({
    tag_name: 'v0.3.0', html_url: 'https://github.com/x/y/releases/tag/v0.3.0', body: "## What's new\n- Faster",
    assets: [
      { name: 'MeetingAgent-0.3.0-arm64.dmg', browser_download_url: 'https://e.com/a.dmg' },
      { name: 'MeetingAgent-Setup-0.3.0-x64.exe', browser_download_url: 'https://e.com/w.exe' }
    ]
  });
  assert.ok(release);
  assert.equal(pickInstaller(release!, 'x64'), 'https://e.com/w.exe');
  assert.equal(pickInstaller(release!, 'arm64'), null);
  assert.equal(headline(release!.notes), "What's new");
  assert.equal(parseRelease({ tag_name: 'v1.0.0', prerelease: true }), null);
  assert.equal(parseRelease({ message: 'Not Found' }), null);
  assert.equal(shouldRemind(null), true);
  assert.equal(shouldRemind(Date.now() - 3600_000), false);
});

test('windows-v and mac-v style tags are read as versions', () => {
  assert.equal(compareVersions('windows-v0.3.0', '0.2.0'), 1);
  assert.equal(isNewer('v0.3.1', '0.3.0'), true);
});
