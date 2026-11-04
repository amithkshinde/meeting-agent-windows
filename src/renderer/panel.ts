// The floating window: shows when a call is detected, records, shows live help, and starts the clean-up afterwards.
interface Detected { app: string; title: string }
interface TLine { id: number; time: number | null; speaker: string; text: string }
interface Suggestion { kind: 'ask' | 'pushback' | 'flag'; text: string; why: string }
interface Insight { recap: string[]; suggestions: Suggestion[] }
interface PanelSettings { liveCaptions: boolean; copilot: boolean; hasKey: boolean; keyKind: string }
interface Answer { q: string; a: string; ok: boolean; pending?: boolean }

type Phase = 'idle' | 'detected' | 'recording' | 'processing';
type Tab = 'now' | 'transcript' | 'ask';

const CHUNK_MS = 40_000;

const root = document.getElementById('root') as HTMLElement;
let phase: Phase = 'idle';
let tab: Tab = 'now';
let detected: Detected | null = null;
let ended = false;
let startedAt = 0;
let marks = 0;
let progress = '';
let note = '';
let liveNote = '';
let ticker: number | undefined;
let settings: PanelSettings = { liveCaptions: false, copilot: true, hasKey: false, keyKind: 'none' };
let lines: TLine[] = [];
let insight: Insight = { recap: [], suggestions: [] };
let answers: Answer[] = [];
let draft = '';

const recorders: { rec: MediaRecorder; kind: string }[] = [];
let streams: MediaStream[] = [];
let pending: Promise<void>[] = [];
let soundTracks: MediaStreamTrack[] = [];
let liveTimer: number | undefined;
let liveRec: MediaRecorder | null = null;
let liveGen = 0;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
/** Just bold and bullet lines, enough for the short answers the AI gives. */
const mdLite = (text: string) => esc(text).split('\n').filter((r) => r.trim()).map((r) => {
  const bullet = /^\s*[-*•]\s+(.*)$/.exec(r);
  const line = (bullet ? bullet[1] : r).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  return bullet ? `<div class="bl">${line}</div>` : `<div>${line}</div>`;
}).join('');
const two = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};
const stamp = (sec: number | null) => (sec === null ? '' : `${Math.floor(sec / 60)}:${two(Math.floor(sec % 60))}`);

const ICON = {
  open: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  hide: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  mark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
  rec: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
};

const KIND_LABEL: Record<string, string> = { ask: 'Ask', pushback: 'Hold your ground', flag: 'Watch out' };

function header(): string {
  const live = phase === 'recording';
  return `<div class="p-head"><span class="p-logo ${live ? 'live' : ''}"></span><span class="brand grow">Meeting Agent</span>
    <button class="icon" data-a="library" title="Open Meeting Agent" aria-label="Open Meeting Agent">${ICON.open}</button>
    <button class="icon" data-a="hide" title="Hide this window" aria-label="Hide">${ICON.hide}</button></div>`;
}

function toggle(id: string, on: boolean, label: string, hint: string): string {
  return `<label class="sw" title="${esc(hint)}"><input type="checkbox" data-a="${id}" ${on ? 'checked' : ''}><i></i><span>${label}</span></label>`;
}

function nowTab(): string {
  let html = `<div class="sws">${toggle('t-live', settings.liveCaptions, 'Live captions', 'Writes down what the other people say while the call is going on')}
    ${toggle('t-copilot', settings.copilot, 'Suggestions', 'Shows what to say next, using your earlier calls')}</div>`;
  if (!settings.hasKey) {
    html += '<p class="hint">Add an AI key in Settings to get captions and suggestions. Recording works without it.</p>';
  } else if (!settings.liveCaptions) {
    html += `<p class="hint">Live captions are off, so nothing is sent to the AI during the call. Turn them on to see what is being said and get suggestions.
      <br><span class="warn">Each minute uses about 1.5 AI requests. The free Gemini plan allows about 20 a day in total.</span></p>`;
  } else if (!lines.length && !liveNote) {
    html += '<p class="hint"><span class="listen"><i></i><i></i><i></i><i></i></span> Listening… the first captions appear after about 40 seconds.</p>';
  }
  if (settings.liveCaptions && settings.copilot && insight.suggestions.length) {
    html += insight.suggestions.map((s) => `<div class="sug ${s.kind}"><small>${KIND_LABEL[s.kind]}</small><p>${esc(s.text)}</p>${s.why ? `<div class="why">${esc(s.why)}</div>` : ''}</div>`).join('');
  } else if (settings.liveCaptions && settings.copilot && lines.length) {
    html += '<p class="hint">Nothing stands out yet. I will speak up when there is something worth saying.</p>';
  }
  if (insight.recap.length) html += `<div class="recap"><small>Last few points</small>${insight.recap.map((r) => `<span>${esc(r)}</span>`).join('')}</div>`;
  const last = lines.slice(-2);
  if (last.length) html += `<div class="just"><small>Just said</small>${last.map((l) => `<p><b>${esc(l.speaker)}</b> ${esc(l.text)}</p>`).join('')}</div>`;
  if (liveNote) html += `<p class="hint warn">${esc(liveNote)}</p>`;
  return html;
}

function transcriptTab(): string {
  if (!lines.length) return '<p class="hint">Nothing written down yet. Turn on live captions on the Now tab.</p>';
  return `<div id="tx-live">${lines.map((l) => `<div class="tl"><span class="t">${stamp(l.time)}</span><span><b>${esc(l.speaker)}</b> ${esc(l.text)}</span></div>`).join('')}</div>`;
}

function askTab(): string {
  const log = answers.map((a) => `<div class="q">${esc(a.q)}</div><div class="a ${a.ok ? '' : 'bad'}">${a.pending ? '<span class="listen"><i></i><i></i><i></i><i></i></span> Looking through your calls…' : mdLite(a.a)}</div>`).join('');
  return `${log || '<p class="hint">Ask anything about this call or your earlier ones. “What did we agree on price last time?”</p>'}
    <div class="ask"><input id="ask-in" placeholder="Ask about your calls…" value="${esc(draft)}" autocomplete="off"><button class="icon send" data-a="ask" aria-label="Ask">${ICON.send}</button></div>`;
}

function render(): void {
  const focusAsk = document.activeElement?.id === 'ask-in';
  const scroll = document.getElementById('p-body')?.scrollTop ?? 0;
  let html = header();

  if (phase === 'idle') {
    html += `<div class="p-card"><div class="big">Ready to listen</div>
      <div class="hint" style="margin:2px 0 12px">Join a call and I will offer to record it. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> starts any time.</div>
      <div class="row"><button class="btn primary" data-a="start">${ICON.rec} Start recording</button><button class="btn" data-a="library">Open</button></div></div>`;
  } else if (phase === 'detected' && detected) {
    html += `<div class="p-card found"><div class="big">${esc(detected.app)} call found</div>
      <div class="hint" style="margin:2px 0 12px">Record it, and I will write up the notes when you hang up.</div>
      <div class="row"><button class="btn primary" data-a="start">${ICON.rec} Record this call</button><button class="btn" data-a="dismiss">Not now</button></div></div>`;
  } else if (phase === 'recording') {
    html += `<div class="p-rec"><span class="dot"></span><span class="timer grow" id="timer">${clock(Date.now() - startedAt)}</span>
      <button class="btn" data-a="mark" title="Ctrl+Shift+B">${ICON.mark} ${marks ? marks : 'Mark'}</button>
      <button class="btn danger" data-a="stop">${ICON.stop} Stop</button></div>
      ${ended ? '<p class="hint warn" style="margin:0 0 8px">The call looks finished. Press Stop to write the notes.</p>' : ''}
      <div class="tabs">${(['now', 'transcript', 'ask'] as Tab[]).map((t) => `<button class="tab ${tab === t ? 'active' : ''}" data-a="tab" data-id="${t}">${t === 'now' ? 'Now' : t === 'transcript' ? 'Transcript' : 'Ask'}</button>`).join('')}</div>
      <div class="p-body" id="p-body">${tab === 'now' ? nowTab() : tab === 'transcript' ? transcriptTab() : askTab()}</div>`;
  } else {
    html += `<div class="p-card"><div class="big"><span class="listen"><i></i><i></i><i></i><i></i></span> ${esc(progress || 'Working…')}</div>
      <div class="hint" style="margin:2px 0 12px">This takes a minute or two. You can keep using your PC.</div><button class="btn" data-a="library">Open library</button></div>`;
  }
  if (note) html += `<p class="hint warn" style="margin:8px 0 0">${esc(note)}</p>`;
  root.innerHTML = html;
  const body = document.getElementById('p-body');
  if (body) {
    if (tab === 'transcript') body.scrollTop = body.scrollHeight; else body.scrollTop = scroll;
  }
  if (focusAsk) {
    const input = document.getElementById('ask-in') as HTMLInputElement | null;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
  void window.api.invoke('panel:resize', Math.ceil(document.documentElement.scrollHeight));
}

function setPhase(next: Phase): void {
  phase = next;
  window.clearInterval(ticker);
  if (next === 'recording') {
    ticker = window.setInterval(() => {
      const el = document.getElementById('timer');
      if (el) el.textContent = clock(Date.now() - startedAt);
    }, 500);
  }
  render();
}

function pickMime(candidates: string[]): string | undefined {
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

function attach(stream: MediaStream, kind: string, mime: string | undefined, video: boolean): void {
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    ...(video ? { videoBitsPerSecond: 1_500_000 } : {}),
    audioBitsPerSecond: kind === 'screen' ? 96_000 : 64_000
  });
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) pending.push(e.data.arrayBuffer().then((buf) => window.api.send('rec:chunk', kind, buf)));
  };
  rec.start(2000);
  recorders.push({ rec, kind });
}

// MARK: live pieces
// A MediaRecorder only writes its header in the first piece, so for live captions the other people's sound is cut
// into short standalone recordings: stop one, hand it over, start the next straight away.

function stopLive(): void {
  liveGen++;
  window.clearTimeout(liveTimer);
  if (liveRec && liveRec.state !== 'inactive') { try { liveRec.stop(); } catch { /* already stopped */ } }
  liveRec = null;
}

function startLive(): void {
  stopLive();
  if (phase !== 'recording' || !settings.liveCaptions || !settings.hasKey || !soundTracks.length) return;
  const gen = liveGen;
  const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm']);
  const cycle = () => {
    if (gen !== liveGen || phase !== 'recording') return;
    const offset = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const rec = new MediaRecorder(new MediaStream(soundTracks.map((t) => t.clone())), { mimeType: mime, audioBitsPerSecond: 48_000 });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: 'audio/webm' });
      if (blob.size > 2000) void blob.arrayBuffer().then((buf) => window.api.invoke('live:chunk', buf, offset)).catch(() => undefined);
    };
    rec.start();
    liveRec = rec;
    liveTimer = window.setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
      cycle();
    }, CHUNK_MS);
  };
  cycle();
}

async function startRecording(app: string, title: string): Promise<void> {
  if (phase === 'recording') return;
  note = '';
  liveNote = '';
  lines = [];
  insight = { recap: [], suggestions: [] };
  answers = [];
  tab = 'now';
  try {
    settings = await window.api.invoke('settings:get');
    // 10 frames a second and at most 1080p keeps files small and text on a shared screen readable.
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 10 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true
    });
    streams = [display];
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streams.push(mic);
    } catch {
      note = 'Your microphone is not available, so only the other people will be written down.';
    }
    await window.api.invoke('rec:start', app, title);

    attach(display, 'screen', pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']), true);
    soundTracks = display.getAudioTracks();
    if (soundTracks.length) attach(new MediaStream(soundTracks), 'system', pickMime(['audio/webm;codecs=opus', 'audio/webm']), false);
    else note = (note ? note + ' ' : '') + "Windows did not share the PC's sound, so the other people may be missing from the transcript.";
    if (mic) attach(mic, 'mic', pickMime(['audio/webm;codecs=opus', 'audio/webm']), false);

    display.getVideoTracks()[0].addEventListener('ended', () => void stopRecording());
    startedAt = Date.now();
    marks = 0;
    ended = false;
    setPhase('recording');
    startLive();
  } catch (error) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    note = `Could not start recording: ${(error as Error).message}`;
    setPhase(detected ? 'detected' : 'idle');
  }
}

async function stopRecording(): Promise<void> {
  if (phase !== 'recording') return;
  stopLive();
  const stops = recorders.map(({ rec }) => new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    if (rec.state !== 'inactive') rec.stop(); else resolve();
  }));
  await Promise.all(stops);
  recorders.length = 0;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  soundTracks = [];
  await Promise.all(pending);
  pending = [];
  progress = 'Saving the recording…';
  setPhase('processing');
  await window.api.invoke('rec:stop');
}

async function bookmark(): Promise<void> {
  if (phase !== 'recording') return;
  const all = await window.api.invoke('rec:bookmark');
  marks = Array.isArray(all) ? all.length : marks + 1;
  render();
}

async function ask(): Promise<void> {
  const q = draft.trim();
  if (!q) return;
  draft = '';
  const entry: Answer = { q, a: '', ok: true, pending: true };
  answers.push(entry);
  render();
  const result = await window.api.invoke('chat:ask', q, '');
  entry.pending = false;
  entry.ok = !!result.ok;
  entry.a = result.text || 'I could not find an answer.';
  render();
}

async function saveSetting(patch: Partial<PanelSettings>): Promise<void> {
  settings = { ...settings, ...(await window.api.invoke('settings:set', patch)) };
  if (phase === 'recording') startLive();
  render();
}

root.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
  const id = (event.target as HTMLElement).closest('[data-a]')?.getAttribute('data-id') ?? '';
  if (action === 'start') void startRecording(detected?.app ?? 'Manual', detected?.title ?? 'Recording');
  else if (action === 'stop') void stopRecording();
  else if (action === 'mark') void bookmark();
  else if (action === 'library') void window.api.invoke('app:open-library');
  else if (action === 'hide') void window.api.invoke('panel:hide');
  else if (action === 'dismiss') { detected = null; setPhase('idle'); }
  else if (action === 'tab') { tab = id as Tab; render(); if (tab === 'ask') (document.getElementById('ask-in') as HTMLInputElement | null)?.focus(); }
  else if (action === 'ask') void ask();
});

root.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement;
  const a = el.getAttribute('data-a');
  if (a === 't-live') void saveSetting({ liveCaptions: el.checked });
  else if (a === 't-copilot') void saveSetting({ copilot: el.checked });
});

root.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'ask-in') draft = el.value;
});

root.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.target as HTMLElement).id === 'ask-in') { event.preventDefault(); void ask(); }
});

window.api.on('detected', (call: Detected) => {
  detected = call;
  if (phase === 'idle') setPhase('detected');
});
window.api.on('call-ended', () => {
  detected = null;
  ended = true;
  if (phase === 'detected') setPhase('idle'); else render();
});
window.api.on('progress', (_id: string, message: string) => {
  progress = message;
  if (phase === 'processing') {
    if (!message) setPhase('idle'); else render();
  }
});
window.api.on('live:lines', (fresh: TLine[]) => {
  lines = lines.concat(fresh).slice(-400);
  render();
});
window.api.on('live:insight', (next: Insight) => {
  insight = next;
  render();
});
window.api.on('live:note', (message: string) => {
  liveNote = message;
  render();
});

window.__startFromMain = (app, title) => void startRecording(app, title);
window.__stopFromMain = () => void stopRecording();
window.__bookmarkFromMain = () => void bookmark();

void window.api.invoke('settings:get').then((s: PanelSettings) => { settings = s; render(); });
render();

export {};
