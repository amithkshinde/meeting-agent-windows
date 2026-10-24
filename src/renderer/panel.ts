// The floating window: shows when a call is detected, records, and starts the clean-up afterwards.
interface Detected { app: string; title: string }

type Phase = 'idle' | 'detected' | 'recording' | 'processing';

const root = document.getElementById('root') as HTMLElement;
let phase: Phase = 'idle';
let detected: Detected | null = null;
let ended = false;
let startedAt = 0;
let marks = 0;
let progress = '';
let note = '';
let ticker: number | undefined;

const recorders: { rec: MediaRecorder; kind: string }[] = [];
let streams: MediaStream[] = [];
let pending: Promise<void>[] = [];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};

function render(): void {
  let html = '<div class="row"><span class="brand grow">Meeting Agent</span>';
  if (phase === 'recording') html += '<span class="dot"></span>';
  html += '</div>';

  if (phase === 'idle') {
    html += `<p class="muted small" style="margin:8px 0 10px">Watching for calls. Ctrl+Shift+R starts a recording any time.</p>
      <div class="row"><button class="btn primary" data-a="start">Record</button><button class="btn" data-a="library">Open</button></div>`;
  } else if (phase === 'detected' && detected) {
    html += `<p style="margin:8px 0 10px"><b>${esc(detected.app)}</b> call detected.<br><span class="muted small">Record it?</span></p>
      <div class="row"><button class="btn primary" data-a="start">Record this call</button><button class="btn" data-a="dismiss">Not now</button></div>`;
  } else if (phase === 'recording') {
    html += `<div class="row" style="margin:6px 0 10px"><span class="timer grow" id="timer">${clock(Date.now() - startedAt)}</span>
      <button class="btn" data-a="mark" title="Ctrl+Shift+B">Mark${marks ? ` · ${marks}` : ''}</button></div>
      ${ended ? '<p class="small" style="margin:0 0 8px;color:#f5b301">The call looks finished.</p>' : ''}
      <div class="row"><button class="btn danger grow" data-a="stop">Stop and write notes</button></div>`;
  } else {
    html += `<p style="margin:8px 0 10px">${esc(progress || 'Working…')}</p><button class="btn" data-a="library">Open library</button>`;
  }
  if (note) html += `<p class="small" style="margin:8px 0 0;color:#f5b301">${esc(note)}</p>`;
  root.innerHTML = html;
  void window.api.invoke('panel:resize', Math.ceil(document.body.scrollHeight) + 4);
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

async function startRecording(app: string, title: string): Promise<void> {
  if (phase === 'recording') return;
  note = '';
  try {
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
    const sound = display.getAudioTracks();
    if (sound.length) attach(new MediaStream(sound), 'system', pickMime(['audio/webm;codecs=opus', 'audio/webm']), false);
    else note = (note ? note + ' ' : '') + "Windows did not share the PC's sound, so the other people may be missing from the transcript.";
    if (mic) attach(mic, 'mic', pickMime(['audio/webm;codecs=opus', 'audio/webm']), false);

    display.getVideoTracks()[0].addEventListener('ended', () => void stopRecording());
    startedAt = Date.now();
    marks = 0;
    ended = false;
    setPhase('recording');
  } catch (error) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    note = `Could not start recording: ${(error as Error).message}`;
    setPhase(detected ? 'detected' : 'idle');
  }
}

async function stopRecording(): Promise<void> {
  if (phase !== 'recording') return;
  const stops = recorders.map(({ rec }) => new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    if (rec.state !== 'inactive') rec.stop(); else resolve();
  }));
  await Promise.all(stops);
  recorders.length = 0;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
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

root.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
  if (action === 'start') void startRecording(detected?.app ?? 'Manual', detected?.title ?? 'Recording');
  else if (action === 'stop') void stopRecording();
  else if (action === 'mark') void bookmark();
  else if (action === 'library') void window.api.invoke('app:open-library');
  else if (action === 'dismiss') { detected = null; setPhase('idle'); }
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

window.__startFromMain = (app, title) => void startRecording(app, title);
window.__stopFromMain = () => void stopRecording();
window.__bookmarkFromMain = () => void bookmark();

render();

export {};
