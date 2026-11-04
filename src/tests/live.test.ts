import test from 'node:test';
import assert from 'node:assert/strict';
import { chatContext, memoryNotes, offsetLines, parseLive, projectsOf } from '../shared/live';
import { parse } from '../shared/transcript';
import { CallRecord } from '../shared/types';

const call = (over: Partial<CallRecord>): CallRecord => ({
  id: 'a', startedAt: '2026-11-01T10:00:00.000Z', durationSec: 600, app: 'Google Meet', title: 'Sync', project: '',
  status: 'done', summary: '- Launch moved to Nov 12', decisions: ['Ship Nov 12'], promises: [], ...over
});

test('parseLive reads suggestions, caps them and fixes unknown kinds', () => {
  const raw = 'Here you go: {"recap":["a","b","c","d"],"suggestions":[{"kind":"flag","text":"Price changed","why":"Oct 3 call"},{"kind":"weird","text":"Ask about budget"},{"kind":"ask","text":"third"}]}';
  const out = parseLive(raw)!;
  assert.equal(out.recap.length, 3);
  assert.equal(out.suggestions.length, 2);
  assert.equal(out.suggestions[1].kind, 'ask');
  assert.equal(out.suggestions[0].why, 'Oct 3 call');
});

test('parseLive returns null for non-JSON', () => {
  assert.equal(parseLive('sorry'), null);
});

test('offsetLines shifts times and drops empty lines', () => {
  const lines = parse('[00:05] Speaker 1: hello\n[00:09] Speaker 1:  \nno stamp here');
  const out = offsetLines(lines, 120);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 125);
});

test('projectsOf groups by name ignoring case and counts open promises', () => {
  const calls = [
    call({ id: '1', project: 'Website', promises: [{ id: 'p', owner: 'Ravi', text: 'x', done: false, mine: false }] }),
    call({ id: '2', project: 'website', startedAt: '2026-11-03T10:00:00.000Z' }),
    call({ id: '3', project: '' })
  ];
  const { projects, loose } = projectsOf(calls);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].calls.length, 2);
  assert.equal(projects[0].open, 1);
  assert.equal(loose.length, 1);
});

test('memoryNotes puts the same project first', () => {
  const notes = memoryNotes([call({ id: '1', title: 'Other', startedAt: '2026-11-05T00:00:00Z' }), call({ id: '2', title: 'Mine', project: 'Web' })], 'web');
  assert.ok(notes.indexOf('Mine') < notes.indexOf('Other'));
});

test('chatContext includes matching transcript lines and respects project scope', () => {
  const calls = [call({ id: '1', title: 'A', project: 'Web' }), call({ id: '2', title: 'B', project: 'App' })];
  const t = new Map([['1', parse('[00:10] Ravi: the budget is tight')], ['2', parse('[00:10] Neha: budget is fine')]]);
  const all = chatContext('budget', calls, t);
  assert.ok(all.includes('Ravi') && all.includes('Neha'));
  const scoped = chatContext('budget', calls, t, 'web');
  assert.ok(scoped.includes('Ravi') && !scoped.includes('Neha'));
});
