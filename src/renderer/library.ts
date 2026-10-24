// The main window: calls, promises, search, feedback and settings.
interface Commitment { id: string; owner: string; text: string; due?: string; done: boolean; mine: boolean }
interface Call { id: string; startedAt: string; durationSec: number; app: string; title: string; project: string; status: string; error?: string; summary: string; decisions: string[]; promises: Commitment[] }
interface TLine { id: number; time: number | null; speaker: string; text: string }
interface Mark { t: number; note: string }
interface Detail { call: Call; transcript: TLine[]; bookmarks: Mark[]; videoUrl: string | null }
interface Hit { kind: string; callId: string; title: string; detail: string; seek?: number }
interface Settings { userName: string; language: string; script: string; watchCalls: boolean; hasKey: boolean; keyKind: string }
interface FbEntry { id: string; date: string; kind: string; message: string; sentVia: string | null }

const KINDS: [string, string][] = [['idea', '💡 Idea'], ['bug', '🐞 Something broke'], ['praise', '❤️ What I liked'], ['question', '❓ Question']];
const PROMPTS: Record<string, string> = {
  idea: 'What do you wish it did, or did differently?',
  bug: 'What happened, and what did you expect? If you can, say what you clicked just before.',
  praise: 'What worked well for you?',
  question: 'What are you trying to do?'
};

let view = 'home';
let calls: Call[] = [];
let detail: Detail | null = null;
let tab = 'summary';
let settings: Settings | null = null;
let hits: Hit[] = [];
let query = '';
let progress: Record<string, string> = {};
let pendingSeek: number | null = null;
let flash = '';
let fbEntries: FbEntry[] = [];
let fbCaps = { email: false, endpoint: false };
const fb = { kind: 'idea', rating: 0, message: '', anonymous: false, name: '', email: '', includeDetails: true, includeLog: false, status: '', ok: true };
let searchTimer: number | undefined;

const root = document.getElementById('root') as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const invoke = (channel: string, ...args: unknown[]) => window.api.invoke(channel, ...args);
const two = (n: number) => String(n).padStart(2, '0');
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`; };
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const mins = (s: number) => (s < 60 ? `${s}s` : `${Math.round(s / 60)} min`);

function md(text: string): string {
  const lines = esc(text).split('\n');
  let out = '';
  let open = false;
  for (const line of lines) {
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) { if (!open) { out += '<ul>'; open = true; } out += `<li>${item[1].replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`; }
    else { if (open) { out += '</ul>'; open = false; } if (line.trim()) out += `<p>${line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`; }
  }
  return out + (open ? '</ul>' : '');
}

const openMine = () => calls.flatMap((c) => c.promises).filter((p) => p.mine && !p.done).length;

// MARK: views

function sidebar(): string {
  const nav = (id: string, label: string, extra = '') => `<button class="nav ${view === id ? 'active' : ''}" data-a="go" data-id="${id}"><span>${label}</span>${extra}</button>`;
  return `<aside class="side"><div class="logo"><i></i>Meeting Agent</div>
    ${nav('search', '🔍 Search <span class="muted small">Ctrl+K</span>')}
    ${nav('home', '🏠 Home')}
    ${nav('promises', '✅ Promises', openMine() ? `<span class="badge">${openMine()}</span>` : '')}
    <div class="grow"></div>
    ${nav('feedback', '💬 Feedback')}
    ${nav('settings', '⚙️ Settings')}</aside>`;
}

function homeView(): string {
  const hour = new Date().getHours();
  const hello = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${settings?.userName ? ', ' + esc(settings.userName) : ''}`;
  let html = `<h1>${hello}</h1><p class="muted">${calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'} saved.` : 'No calls yet.'} Press <b>Ctrl+Shift+R</b> any time to record, or just join a call and I will offer.</p>`;
  if (settings && !settings.hasKey) html += `<div class="card"><h2>Connect the AI</h2><p class="muted">Transcripts and summaries need a key. A free Google Gemini key takes about two minutes.</p><button class="btn primary" data-a="go" data-id="settings">Set it up</button></div>`;
  if (!calls.length) html += `<div class="card" style="text-align:center;padding:40px"><h2>Your calls will show up here</h2><p class="muted">Join a Google Meet, Zoom or Teams call, or press Ctrl+Shift+R.</p></div>`;
  for (const c of calls) {
    const state = progress[c.id] ? `<span class="pill work">${esc(progress[c.id])}</span>` : c.status === 'processing' ? '<span class="pill work">Writing notes…</span>' : c.status === 'recording' ? '<span class="pill err">Recording</span>' : c.status === 'error' ? '<span class="pill err">Needs attention</span>' : '';
    html += `<button class="card call" data-a="open" data-id="${c.id}"><div class="row"><b class="grow">${esc(c.title)}</b>${state}</div>
      <div class="muted small">${when(c.startedAt)} · ${esc(c.app)}${c.durationSec ? ' · ' + mins(c.durationSec) : ''}${c.project ? ' · ' + esc(c.project) : ''}</div>
      ${c.summary ? `<div class="small" style="margin-top:6px;opacity:.85">${esc(c.summary.replace(/^\s*[-*•]\s*/gm, '').split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 220))}</div>` : ''}</button>`;
  }
  return html;
}

function callView(): string {
  if (!detail) return '<p class="muted">Loading…</p>';
  const { call, transcript, bookmarks, videoUrl } = detail;
  const speakers = [...new Set(transcript.map((l) => l.speaker).filter(Boolean))];
  let side = '';
  if (tab === 'summary') {
    side = `<div class="summary">${call.summary ? md(call.summary) : '<p class="muted">No summary yet.</p>'}</div>`;
    if (call.decisions.length) side += `<h3>Decisions</h3><ul>${call.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`;
    if (call.promises.length) side += `<h3>Promises</h3>${call.promises.map((p) => `<label class="row" style="padding:3px 0"><input type="checkbox" style="width:auto" data-a="toggle" data-id="${p.id}" ${p.done ? 'checked' : ''}><span class="grow"><b>${p.mine ? 'You' : esc(p.owner)}:</b> ${esc(p.text)}${p.due ? ` <span class="muted">· ${esc(p.due)}</span>` : ''}</span></label>`).join('')}`;
  } else if (tab === 'transcript') {
    side = transcript.length
      ? `<div id="tx">${transcript.map((l) => `<div class="tline" data-a="seek" data-t="${l.time ?? ''}" data-i="${l.id}"><span class="t">${l.time === null ? '' : clock(l.time)}</span><span><span class="who">${esc(l.speaker)}</span>${esc(l.text)}</span></div>`).join('')}</div>`
      : '<p class="muted">No transcript yet.</p>';
    if (speakers.length) side += `<h3>Rename a speaker</h3><div class="row"><select id="rn-from">${speakers.map((s) => `<option>${esc(s)}</option>`).join('')}</select><input id="rn-to" placeholder="New name"><button class="btn" data-a="rename">Rename</button></div>`;
  } else {
    side = bookmarks.length
      ? bookmarks.map((b) => `<div class="tline" data-a="seek" data-t="${b.t}"><span class="t">${clock(b.t)}</span><span>${esc(b.note || 'Marked moment')}</span></div>`).join('')
      : '<p class="muted">No marked moments. Press Ctrl+Shift+B during a call to mark one.</p>';
  }
  const status = progress[call.id] || (call.status === 'processing' ? 'Writing notes…' : '');
  return `<button class="btn" data-a="go" data-id="home">← All calls</button>
    <div class="row" style="margin:12px 0 4px"><input id="c-title" value="${esc(call.title)}" style="font-size:20px;font-weight:600;background:transparent;border-color:transparent"><button class="btn" data-a="md">Export Markdown</button><button class="btn" data-a="delete">Delete</button></div>
    <div class="row muted small" style="margin-bottom:12px">${when(call.startedAt)} · ${esc(call.app)} · ${mins(call.durationSec)} · Project <input id="c-project" value="${esc(call.project)}" placeholder="none" style="width:160px;padding:3px 8px"> ${status ? `<span class="pill work">${esc(status)}</span>` : ''}</div>
    ${call.status === 'error' ? `<div class="card"><b class="bad">${esc(call.error ?? 'Something went wrong.')}</b><div style="margin-top:10px"><button class="btn primary" data-a="retry">Retry</button></div></div>` : ''}
    <div class="detail"><div>${videoUrl ? `<video id="vid" src="${videoUrl}" controls></video>` : '<div class="card muted">No video was saved for this call.</div>'}</div>
    <div><div class="tabs">${['summary', 'transcript', 'highlights'].map((t) => `<button class="tab ${tab === t ? 'active' : ''}" data-a="tab" data-id="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>${side}</div></div>`;
}

function promisesView(): string {
  const all = calls.flatMap((c) => c.promises.map((p) => ({ p, c })));
  const open = all.filter((x) => !x.p.done);
  const row = (x: { p: Commitment; c: Call }) => `<label class="card row" style="margin-bottom:8px"><input type="checkbox" style="width:auto" data-a="toggle" data-call="${x.c.id}" data-id="${x.p.id}" ${x.p.done ? 'checked' : ''}><span class="grow"><b>${x.p.mine ? 'You' : esc(x.p.owner)}:</b> ${esc(x.p.text)}<div class="muted small">${esc(x.c.title)} · ${when(x.c.startedAt)}${x.p.due ? ' · ' + esc(x.p.due) : ''}</div></span></label>`;
  return `<h1>Promises</h1><p class="muted">Everything anyone committed to on your calls.</p>
    <h3>Open (${open.length})</h3>${open.length ? open.map(row).join('') : '<p class="muted">Nothing open.</p>'}
    <h3>Done</h3>${all.filter((x) => x.p.done).map(row).join('') || '<p class="muted">Nothing done yet.</p>'}`;
}

function searchView(): string {
  const label: Record<string, string> = { call: 'Calls', moment: 'Moments', promise: 'Promises' };
  let html = `<h1>Search</h1><input id="q" placeholder="Search calls, what was said, and promises…" value="${esc(query)}" autofocus>`;
  if (query.trim().length < 2) html += '<p class="muted" style="margin-top:14px">Finds the exact moment something was said, and opens the video right there.</p>';
  else if (!hits.length) html += `<p class="muted" style="margin-top:14px">Nothing found for “${esc(query)}”.</p>`;
  for (const kind of ['call', 'moment', 'promise']) {
    const group = hits.filter((h) => h.kind === kind);
    if (!group.length) continue;
    html += `<h3>${label[kind]}</h3>` + group.map((h) => `<button class="hit" data-a="hit" data-id="${h.callId}" data-t="${h.seek ?? ''}"><b>${esc(h.title)}</b><div class="muted small">${esc(h.detail)}</div></button>`).join('');
  }
  return html;
}

function feedbackView(): string {
  const stat = fb.status ? `<p class="${fb.ok ? 'ok' : 'bad'}">${esc(fb.status)}</p>` : '';
  const emailBad = !fb.anonymous && fb.email && !/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(fb.email.trim());
  return `<div class="narrow"><h1>Feedback</h1><p class="muted">Tell me what works, what doesn't, and what you wish it did. I read every note, and it shapes what gets built next.</p>
    <div class="card"><h2>What kind of feedback?</h2><div class="row" style="flex-wrap:wrap;margin-bottom:12px">${KINDS.map(([k, l]) => `<button class="chip ${fb.kind === k ? 'on' : ''}" data-a="fb-kind" data-id="${k}">${l}</button>`).join('')}</div>
      <div class="row" style="margin-bottom:10px"><span class="muted grow">How does the app feel overall?</span><span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button class="${fb.rating >= n ? 'on' : ''}" data-a="fb-rate" data-id="${n}">★</button>`).join('')}</span></div>
      <textarea id="fb-msg" placeholder="${esc(PROMPTS[fb.kind])}">${esc(fb.message)}</textarea></div>
    <div class="card"><h2>Who is this from?</h2><div class="seg" style="margin-bottom:10px"><button class="${!fb.anonymous ? 'on' : ''}" data-a="fb-anon" data-id="0">Put my name on it</button><button class="${fb.anonymous ? 'on' : ''}" data-a="fb-anon" data-id="1">Stay anonymous</button></div>
      ${fb.anonymous
        ? `<p class="muted">Nothing about you is added to the message. That's completely fine. The only catch is that I can't write back to ask what you meant.</p>${fbCaps.endpoint ? '' : '<p class="muted small">Without an online form behind this button, your mail app or GitHub account still shows who you are. To be fully anonymous, use Copy and send it your own way.</p>'}`
        : `<p class="muted">I'd love to know who you are, so I can email you if I don't follow something or want to talk it through. Both boxes are optional.</p><div class="row"><input id="fb-name" placeholder="Your name" value="${esc(fb.name)}"><input id="fb-email" placeholder="Your email, for replies" value="${esc(fb.email)}"></div>${emailBad ? '<p class="bad small">That email doesn\'t look right. Fix it, or clear the box to send without one.</p>' : ''}`}</div>
    <div class="card"><label class="row"><input type="checkbox" style="width:auto" id="fb-det" ${fb.includeDetails ? 'checked' : ''}><span><b>Include technical details</b><div class="muted small">App version, Windows version and chip. Helps me reproduce a problem. Never your calls, transcripts or keys.</div></span></label></div>
    <div class="row"><button class="btn primary" data-a="fb-send" data-id="auto">Send feedback</button>
      ${fbCaps.email ? '<button class="btn" data-a="fb-send" data-id="email">Email</button>' : ''}<button class="btn" data-a="fb-send" data-id="github">GitHub issue</button><button class="btn" data-a="fb-send" data-id="copied">Copy</button></div>${stat}
    ${fbEntries.length ? `<div class="card" style="margin-top:16px"><h2>Your earlier feedback</h2>${fbEntries.slice(0, 8).map((e) => `<div style="padding:4px 0"><div>${esc(e.message.slice(0, 120))}</div><div class="muted small">${when(e.date)} · ${e.sentVia ?? 'saved on this PC'}</div></div>`).join('')}</div>` : ''}</div>`;
}

function settingsView(): string {
  if (!settings) return '';
  const s = settings;
  const sel = (id: string, value: string, opts: [string, string][]) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="narrow"><h1>Settings</h1>
    <div class="card"><h2>AI key</h2>${s.hasKey ? `<p class="ok">✓ ${s.keyKind === 'claude' ? 'Claude' : 'Google Gemini'} key saved (encrypted on this PC).</p>` : '<p class="muted">Paste a key to get transcripts and summaries.</p>'}
      <div class="row"><input id="key" type="password" placeholder="Paste a Gemini key (starts with AIza) or Claude key (sk-ant-)"><button class="btn primary" data-a="save-key">Save</button>${s.hasKey ? '<button class="btn" data-a="clear-key">Remove</button>' : ''}</div>
      <p class="muted small" style="margin-bottom:0">Transcripts need a Gemini key (Claude can't listen to audio yet). The free Gemini plan allows about 20 requests a day, and each call uses three. Get one at aistudio.google.com/apikey. Only audio and text are sent to the AI. Video stays on this PC.</p></div>
    <div class="card"><h2>Language</h2><div class="row">${sel('lang', s.language, [['auto', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['hinglish', 'Hinglish (Hindi and English mixed)']])}${sel('script', s.script, [['roman', 'Write Hindi in English letters'], ['devanagari', 'Write Hindi in Devanagari']])}</div></div>
    <div class="card"><h2>You</h2><input id="uname" value="${esc(s.userName)}" placeholder="Your name"><p class="muted small" style="margin-bottom:0">Used to tell which promises are yours.</p></div>
    <div class="card"><label class="row"><input type="checkbox" style="width:auto" id="watch" ${s.watchCalls ? 'checked' : ''}><span><b>Watch for calls</b><div class="muted small">Looks at window titles every few seconds to notice Google Meet, Zoom and Teams. Nothing is recorded until you say so.</div></span></label></div>
    <div class="card"><h2>Where things are saved</h2><button class="btn" data-a="folder">Open the MeetingAgent folder</button></div></div>`;
}

function render(): void {
  const body = view === 'home' ? homeView() : view === 'call' ? callView() : view === 'promises' ? promisesView() : view === 'search' ? searchView() : view === 'feedback' ? feedbackView() : settingsView();
  const keep = (document.activeElement as HTMLElement | null)?.id;
  root.innerHTML = sidebar() + `<main class="main">${flash ? `<p class="ok">${esc(flash)}</p>` : ''}${body}</main>`;
  if (keep) (document.getElementById(keep) as HTMLInputElement | null)?.focus();
  const video = document.getElementById('vid') as HTMLVideoElement | null;
  if (video) {
    const follow = () => {
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#tx .tline'));
      let now: HTMLElement | null = null;
      for (const el of lines) { const t = Number(el.dataset.t); if (el.dataset.t !== '' && t <= video.currentTime + 0.5) now = el; }
      lines.forEach((el) => el.classList.toggle('now', el === now));
    };
    video.addEventListener('timeupdate', follow);
    if (pendingSeek !== null) {
      const t = pendingSeek;
      pendingSeek = null;
      const go = () => { video.currentTime = t; void video.play().catch(() => undefined); };
      if (video.readyState >= 1) go(); else video.addEventListener('loadedmetadata', go, { once: true });
    }
  }
  const q = document.getElementById('q') as HTMLInputElement | null;
  if (q && view === 'search') q.setSelectionRange(q.value.length, q.value.length);
}

// MARK: actions

async function load(): Promise<void> {
  calls = await invoke('calls:list');
  settings = await invoke('settings:get');
  if (view === 'call' && detail) detail = await invoke('call:get', detail.call.id);
  render();
}

async function openCall(id: string, seek: number | null = null): Promise<void> {
  detail = await invoke('call:get', id);
  view = 'call';
  tab = seek !== null ? 'transcript' : tab;
  pendingSeek = seek;
  render();
}

async function go(id: string): Promise<void> {
  view = id;
  flash = '';
  if (id === 'feedback') {
    const info = await invoke('feedback:list');
    fbEntries = info.entries;
    fbCaps = { email: info.email, endpoint: info.endpoint };
    if (!fb.name) fb.name = settings?.userName ?? '';
  }
  render();
}

root.addEventListener('click', async (event) => {
  const el = (event.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
  if (!el) return;
  const a = el.dataset.a;
  const id = el.dataset.id ?? '';
  const num = (v?: string) => (v === undefined || v === '' ? null : Number(v));
  if (a === 'go') await go(id);
  else if (a === 'open') await openCall(id);
  else if (a === 'tab') { tab = id; render(); }
  else if (a === 'seek') {
    const t = num(el.dataset.t);
    const video = document.getElementById('vid') as HTMLVideoElement | null;
    if (video && t !== null) { video.currentTime = Math.max(0, t - 2); void video.play().catch(() => undefined); }
  }
  else if (a === 'hit') await openCall(id, num(el.dataset.t));
  else if (a === 'toggle') { await invoke('promise:toggle', el.dataset.call ?? detail?.call.id, id); await load(); }
  else if (a === 'retry' && detail) { await invoke('call:retry', detail.call.id); await load(); }
  else if (a === 'delete' && detail) { if (await invoke('call:delete', detail.call.id)) { detail = null; await go('home'); await load(); } }
  else if (a === 'md' && detail) { if (await invoke('export:markdown', detail.call.id)) { flash = 'Saved.'; render(); } }
  else if (a === 'rename' && detail) {
    const from = (document.getElementById('rn-from') as HTMLSelectElement).value;
    const to = (document.getElementById('rn-to') as HTMLInputElement).value;
    if (to.trim()) { await invoke('speaker:rename', detail.call.id, from, to); await load(); }
  }
  else if (a === 'save-key') { const input = document.getElementById('key') as HTMLInputElement; if (input.value.trim()) { settings = await invoke('key:set', input.value); flash = 'Key saved.'; render(); } }
  else if (a === 'clear-key') { settings = await invoke('key:clear'); render(); }
  else if (a === 'folder') await invoke('app:open-folder');
  else if (a === 'fb-kind') { fb.kind = id; render(); }
  else if (a === 'fb-rate') { fb.rating = fb.rating === Number(id) ? 0 : Number(id); render(); }
  else if (a === 'fb-anon') { fb.anonymous = id === '1'; render(); }
  else if (a === 'fb-send') {
    const result = await invoke('feedback:send', { kind: fb.kind, rating: fb.rating || null, message: fb.message, anonymous: fb.anonymous, name: fb.name, email: fb.email, includeDetails: fb.includeDetails, includeLog: false }, id);
    fb.status = result.message;
    fb.ok = result.ok;
    if (result.ok && id !== 'copied') { fb.message = ''; fb.rating = 0; }
    fbEntries = (await invoke('feedback:list')).entries;
    render();
  }
});

root.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'q') {
    query = el.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => { hits = query.trim().length >= 2 ? await invoke('search', query) : []; render(); }, 180);
  } else if (el.id === 'fb-msg') fb.message = el.value;
  else if (el.id === 'fb-name') fb.name = el.value;
  else if (el.id === 'fb-email') fb.email = el.value;
});

root.addEventListener('change', async (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'fb-det') fb.includeDetails = el.checked;
  else if (el.id === 'lang') { settings = await invoke('settings:set', { language: el.value }); }
  else if (el.id === 'script') { settings = await invoke('settings:set', { script: el.value }); }
  else if (el.id === 'uname') { settings = await invoke('settings:set', { userName: el.value }); }
  else if (el.id === 'watch') { settings = await invoke('settings:set', { watchCalls: el.checked }); }
  else if (el.id === 'c-title' && detail) { await invoke('call:update', detail.call.id, { title: el.value }); await load(); }
  else if (el.id === 'c-project' && detail) { await invoke('call:update', detail.call.id, { project: el.value }); await load(); }
  else if (el.id === 'fb-email') render();
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); void go('search'); }
});

window.api.on('calls-changed', () => void load());
window.api.on('progress', (id: string, message: string) => {
  if (message) progress[id] = message; else delete progress[id];
  render();
});
window.api.on('cmd:goto', (target: string) => void go(target));

void load();

export {};
