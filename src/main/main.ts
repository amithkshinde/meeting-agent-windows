import { BrowserWindow, Menu, Notification, Tray, app, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CallDebouncer, matchCall } from '../shared/detect';
import { DetectedCall, Settings } from '../shared/types';
import { rename } from '../shared/transcript';
import { search } from '../shared/search';
import { markdown, html, fileName } from './exporter';
import * as feedback from './feedbackService';
import * as health from './health';
import * as ledger from './ledger';
import { beginSession, endSession, log } from './log';
import * as parakeet from './parakeet';
import * as live from './live';
import { CHAT_SYSTEM, chatContext, chatPrompt } from '../shared/live';
import { AIError, complete } from './ai';
import { processCall } from './pipeline';
import * as updater from './updater';
import { diskVerdict, plain, shouldResume, EndReason, failures, countRecent } from '../shared/logcore';
import { clearKey, keyKind, loadKey, saveKey } from './secrets';
import * as store from './store';
import { listWindows } from './windows';

let panel: BrowserWindow | null = null;
let library: BrowserWindow | null = null;
let tray: Tray | null = null;

interface Recording {
  id: string;
  startedAt: number;
  app: string;
  title: string;
  streams: Record<string, fs.WriteStream>;
  lastChunk: number;
  chunks: Record<string, number>;
}
let recording: Recording | null = null;
let resumeCount = 0;
let lastSleepStop: { app: string; title: string; at: number } | null = null;
let lowDiskShown = false;
let detected: DetectedCall | null = null;
const debouncer = new CallDebouncer();

const preload = path.join(__dirname, 'preload.js');
const ui = (file: string) => path.join(__dirname, '..', '..', 'ui', file);
const iconPath = path.join(__dirname, '..', '..', '..', 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => openLibrary());

// MARK: windows

function createPanel(): void {
  const { workArea } = screen.getPrimaryDisplay();
  panel = new BrowserWindow({
    width: 392, height: 120, x: workArea.x + workArea.width - 412, y: workArea.y + workArea.height - 140,
    frame: false, alwaysOnTop: true, resizable: false, skipTaskbar: true, show: false, title: 'Meeting Agent',
    backgroundColor: '#12131a',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.loadFile(ui('panel.html'));
  panel.on('closed', () => { panel = null; });
}

function openLibrary(view?: string): void {
  if (library && !library.isDestroyed()) {
    library.show();
    library.focus();
  } else {
    library = new BrowserWindow({
      width: 1120, height: 740, minWidth: 820, minHeight: 560, title: 'Meeting Agent', backgroundColor: '#12131a',
      autoHideMenuBar: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
    });
    library.loadFile(ui('library.html'));
    library.on('closed', () => { library = null; });
  }
  if (view) library.webContents.once('did-finish-load', () => library?.webContents.send('cmd:goto', view));
}

function showPanel(): void {
  if (panel && !panel.isDestroyed()) panel.showInactive();
}

/** Runs a function in the panel page as if the person clicked, which getDisplayMedia needs. */
function inPanel(code: string): void {
  panel?.webContents.executeJavaScript(code, true).catch(() => undefined);
}

function startRecordingNow(call?: DetectedCall): void {
  if (recording) return;
  const target = call ?? detected ?? { app: 'Manual', title: 'Recording' };
  showPanel();
  inPanel(`window.__startFromMain(${JSON.stringify(target.app)}, ${JSON.stringify(target.title)})`);
}

function stopRecordingNow(reason: EndReason = 'manualStop', detail = ''): void {
  inPanel(`window.__stopFromMain(${JSON.stringify(reason)}, ${JSON.stringify(detail)})`);
}

function bookmarkNow(): void {
  inPanel('window.__bookmarkFromMain()');
}

// MARK: tray and shortcuts

function createTray(): void {
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('Meeting Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Meeting Agent', click: () => openLibrary() },
    { label: 'Start or stop recording   Ctrl+Shift+R', click: () => (recording ? stopRecordingNow() : startRecordingNow()) },
    { label: 'Bookmark this moment   Ctrl+Shift+B', click: () => bookmarkNow() },
    { label: 'Show or hide the floating window', click: () => (panel?.isVisible() ? panel.hide() : showPanel()) },
    { type: 'separator' },
    { label: 'Send feedback…', click: () => openLibrary('feedback') },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', () => openLibrary());
}

function registerShortcuts(): void {
  globalShortcut.register('Control+Shift+R', () => (recording ? stopRecordingNow() : startRecordingNow()));
  globalShortcut.register('Control+Shift+B', () => bookmarkNow());
}

// MARK: call detection

function startWatching(): void {
  const tick = async () => {
    if (store.readSettings().watchCalls) {
      const result = debouncer.feed(matchCall(await listWindows()));
      if (result.started) {
        detected = result.started;
        log.info('detect', `Call detected: ${detected.app}, window "${detected.title}"`);
        panel?.webContents.send('detected', detected);
        if (!recording) {
          showPanel();
          const n = new Notification({ title: `${detected.app} call detected`, body: 'Click to start recording.' });
          n.on('click', () => startRecordingNow(detected ?? undefined));
          n.show();
        }
      }
      if (result.ended) {
        log.info('detect', `Call no longer detected: ${result.ended.app}${recording ? ' (still recording; the app never stops a recording by itself)' : ''}`);
        detected = null;
        panel?.webContents.send('call-ended', result.ended);
      }
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 3000);
}

// MARK: screen and system audio

function setupCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    // 'loopback' is what the PC is playing, which is the other people on the call.
    callback({ video: sources[0], audio: 'loopback' });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(['media', 'display-capture'].includes(permission)));
}

// MARK: IPC

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => fn(...args));
}

function changed(): void {
  library?.webContents.send('calls-changed');
}

function settingsView(): Settings {
  const key = loadKey();
  return { ...store.readSettings(), hasKey: !!key, keyKind: keyKind(key) };
}

async function finishRecording(current: Recording, reason: EndReason, detail: string): Promise<void> {
  await Promise.all(Object.values(current.streams).map((s) => new Promise<void>((resolve) => s.end(resolve))));
  const seconds = Math.round((Date.now() - current.startedAt) / 1000);
  ledger.finish(current.id, reason, detail);
  const line = `Recording ended after ${Math.floor(seconds / 60)} min ${seconds % 60} s: ${plain(reason)}${detail ? ` (${detail})` : ''}. Chunks received: screen ${current.chunks.screen}, system ${current.chunks.system}, mic ${current.chunks.mic}`;
  if (['manualStop', 'callEnded', 'quit'].includes(reason)) log.info('recorder', line); else log.warn('recorder', line);
  const call = store.readCall(current.id);
  if (call) {
    call.durationSec = seconds;
    call.status = 'processing';
    store.writeCall(call);
  }
  changed();
  void processCall(current.id, (message) => {
    panel?.webContents.send('progress', current.id, message);
    library?.webContents.send('progress', current.id, message);
  }).then(() => {
    changed();
    panel?.webContents.send('progress', current.id, '');
  });
}

function setupIpc(): void {
  handle('rec:start', (appName: string, title: string, resumedFrom?: string | null) => {
    const call = store.newCall(appName, title);
    live.reset();
    const dir = store.folder(call.id);
    if (!resumedFrom) resumeCount = 0;
    recording = {
      id: call.id,
      startedAt: Date.now(),
      app: appName,
      title,
      lastChunk: Date.now(),
      chunks: { screen: 0, system: 0, mic: 0 },
      streams: {
        screen: fs.createWriteStream(path.join(dir, 'screen.webm')),
        system: fs.createWriteStream(path.join(dir, 'system.webm')),
        mic: fs.createWriteStream(path.join(dir, 'mic.webm'))
      }
    };
    for (const [kind, stream] of Object.entries(recording.streams)) {
      stream.on('error', (error) => log.error('recorder', `Could not write ${kind}.webm: ${error.message}`));
    }
    const free = health.freeBytes(store.root());
    ledger.begin({ id: call.id, app: appName, startedAt: new Date().toISOString(), automatic: false, resumedFrom: resumedFrom ?? undefined, freeGBAtStart: free === null ? undefined : Math.round(free / 1e8) / 10 });
    log.info('recorder', `Recording started: ${appName}, window "${title}"${resumedFrom ? ', continuing after an interruption' : ''}`);
    changed();
    return { id: call.id };
  });

  ipcMain.on('rec:chunk', (_event, kind: string, data: ArrayBuffer) => {
    if (!recording) return;
    recording.lastChunk = Date.now();
    recording.chunks[kind] = (recording.chunks[kind] ?? 0) + 1;
    recording.streams[kind]?.write(Buffer.from(data));
  });

  ipcMain.on('log:write', (_event, level: 'info' | 'warn' | 'error', message: string) => {
    const lv = level === 'warn' || level === 'error' ? level : 'info';
    log[lv]('panel', String(message).slice(0, 2000));
  });

  handle('rec:stop', async (reason: EndReason = 'manualStop', detail = '') => {
    const current = recording;
    if (!current) return { resume: false };
    recording = null;
    await finishRecording(current, reason, detail);
    const callStillThere = detected !== null || current.app === 'Manual';
    const resume = shouldResume(reason, resumeCount, callStillThere);
    if (resume) {
      resumeCount += 1;
      log.warn('recorder', `Starting a new recording to continue this call (attempt ${resumeCount} of 3)`);
      return { resume: true, app: current.app, title: current.title, from: current.id };
    }
    if (!['manualStop', 'callEnded', 'quit'].includes(reason)) {
      log.error('recorder', `Recording ended early and was not restarted: ${plain(reason)}. ${detail}`);
    }
    return { resume: false };
  });

  handle('rec:bookmark', () => {
    if (!recording) return [];
    return store.addBookmark(recording.id, Math.round((Date.now() - recording.startedAt) / 1000));
  });

  handle('detect:state', () => ({ detected, recording: recording?.id ?? null }));
  handle('panel:resize', (height: number) => {
    if (!panel) return;
    const { workArea } = screen.getPrimaryDisplay();
    const [width] = panel.getSize();
    const h = Math.min(Math.max(height, 90), workArea.height - 40);
    panel.setBounds({ x: workArea.x + workArea.width - width - 20, y: workArea.y + workArea.height - h - 20, width, height: h });
  });
  handle('panel:hide', () => panel?.hide());
  handle('app:open-library', (view?: string) => openLibrary(view));

  handle('calls:list', () => store.listCalls());
  handle('call:get', (id: string) => {
    const call = store.readCall(id);
    if (!call) return null;
    const video = path.join(store.folder(id), 'screen.webm');
    return {
      call,
      transcript: store.readTranscript(id),
      bookmarks: store.readBookmarks(id),
      videoUrl: fs.existsSync(video) ? pathToFileURL(video).href : null
    };
  });
  handle('call:update', (id: string, patch: { title?: string; project?: string }) => {
    const call = store.readCall(id);
    if (!call) return;
    if (typeof patch.title === 'string' && patch.title.trim()) call.title = patch.title.trim();
    if (typeof patch.project === 'string') call.project = patch.project.trim();
    store.writeCall(call);
    changed();
  });
  handle('call:retry', (id: string) => {
    void processCall(id, (m) => library?.webContents.send('progress', id, m)).then(changed);
    changed();
  });
  handle('call:delete', async (id: string) => {
    const call = store.readCall(id);
    if (!call) return false;
    const answer = await dialog.showMessageBox(library ?? undefined!, {
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Delete “${call.title}”?`, detail: 'The video, audio, transcript and summary are removed from this PC.'
    });
    if (answer.response !== 0) return false;
    fs.rmSync(store.folder(id), { recursive: true, force: true });
    changed();
    return true;
  });
  handle('promise:toggle', (callId: string, promiseId: string) => {
    const call = store.readCall(callId);
    const promise = call?.promises.find((p) => p.id === promiseId);
    if (!call || !promise) return;
    promise.done = !promise.done;
    store.writeCall(call);
    changed();
  });
  handle('speaker:rename', (id: string, from: string, to: string) => {
    const raw = store.readTranscriptRaw(id);
    if (raw && to.trim()) fs.writeFileSync(store.transcriptPath(id), rename(raw, from, to.trim()));
    changed();
  });
  handle('export:markdown', async (id: string) => {
    const call = store.readCall(id);
    if (!call) return false;
    const result = await dialog.showSaveDialog(library ?? undefined!, { defaultPath: fileName(call, 'md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, markdown(call, store.readTranscript(id)));
    return true;
  });
  handle('search', (query: string) => {
    const calls = store.listCalls();
    const transcripts = new Map(calls.map((c) => [c.id, store.readTranscript(c.id)] as const));
    return search(query, calls, transcripts);
  });

  handle('live:chunk', (data: ArrayBuffer, offsetSec: number) => live.chunk(data, offsetSec, (channel, ...args) => panel?.webContents.send(channel, ...args)));

  handle('chat:ask', async (question: string, project: string) => {
    const key = loadKey();
    if (!key) return { ok: false, text: 'Add an AI key in Settings and I can answer from your calls.' };
    const q = String(question ?? '').trim();
    if (!q) return { ok: false, text: '' };
    const calls = store.listCalls().filter((c) => c.status === 'done');
    const transcripts = new Map(calls.map((c) => [c.id, store.readTranscript(c.id)] as const));
    // During a call, what has just been said live counts too.
    const liveText = recording ? live.current().slice(-30).map((l) => `${l.speaker}: ${l.text}`).join('\n') : '';
    const context = chatContext(q, calls, transcripts, project || '') + (liveText ? `\n\nThe call happening right now (latest lines):\n${liveText}` : '');
    try {
      return { ok: true, text: await complete(key, CHAT_SYSTEM, chatPrompt(q, context), false, 1500) };
    } catch (error) {
      return { ok: false, text: error instanceof AIError ? error.message : 'I could not reach the AI service. Try again in a moment.' };
    }
  });

  handle('export:pdf', async (id: string) => {
    const call = store.readCall(id);
    if (!call) return false;
    const result = await dialog.showSaveDialog(library ?? undefined!, { defaultPath: fileName(call, 'pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return false;
    const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(call, store.readTranscript(id))));
      fs.writeFileSync(result.filePath, await page.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
      return true;
    } finally {
      page.destroy();
    }
  });

  handle('settings:get', () => settingsView());
  handle('settings:set', (patch: Partial<Settings>) => {
    store.writeSettings(patch);
    return settingsView();
  });
  handle('key:set', (key: string) => {
    saveKey(key);
    return settingsView();
  });
  handle('key:clear', () => {
    clearKey();
    return settingsView();
  });

  handle('feedback:list', () => ({ entries: feedback.list(), ...feedback.capabilities() }));
  handle('feedback:send', (input: feedback.SendInput, route: 'auto' | 'online' | 'email' | 'github' | 'copied') => feedback.send(input, route));
  handle('app:open-folder', () => shell.openPath(store.root()));

  handle('health:summary', () => {
    const all = ledger.read();
    return {
      version: app.getVersion(),
      total: countRecent(all, 30),
      failed: failures(all, 30).length,
      recent: all.slice(-5).reverse().map((e) => ({ app: e.app, startedAt: e.startedAt, endedAt: e.endedAt ?? null, reason: e.reason ? plain(e.reason) : 'still recording', normal: !e.reason || ['manualStop', 'callEnded', 'quit'].includes(e.reason) }))
    };
  });
  handle('health:report', (input: health.ReportInput) => health.sendReport(input));
  handle('health:open-logs', () => health.openLogs());
  handle('update:state', () => updater.getState());
  handle('update:check', () => updater.check(true));
  handle('update:download', () => updater.download());
  handle('speech:state', () => ({ ...parakeet.getState(), text: parakeet.describe(), installed: parakeet.isInstalled() }));
  handle('speech:prepare', () => parakeet.prepare().then(() => true, () => false));
}

// MARK: start

process.on('uncaughtException', (error) => log.error('app', `Uncaught error: ${error.stack ?? error.message}`));
process.on('unhandledRejection', (reason) => log.error('app', `Unhandled promise error: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
app.on('render-process-gone', (_event, contents, details) => {
  log.error('app', `A window's process ended (${details.reason}, exit code ${details.exitCode})`);
  if (recording && contents === panel?.webContents) {
    const current = recording;
    recording = null;
    void finishRecording(current, 'rendererCrashed', details.reason);
    resumeCount += 1;
    // Rebuild the floating window; the person can press Record again, or it carries on if the call is still going.
    panel?.destroy();
    createPanel();
    if (detected && resumeCount <= 3) setTimeout(() => startRecordingNow(detected ?? undefined), 4000);
  }
});
app.on('child-process-gone', (_event, details) => log.warn('app', `A helper process ended: ${details.type} (${details.reason})`));

/** Every 15 seconds: is sound and picture still arriving, and is there room on the disk? */
function watchRecording(): void {
  setInterval(() => {
    if (!recording) { lowDiskShown = false; return; }
    const silentFor = Date.now() - recording.lastChunk;
    if (silentFor > 30_000) {
      log.error('recorder', `Nothing has arrived from the capture for ${Math.round(silentFor / 1000)} s. Chunks: screen ${recording.chunks.screen}, system ${recording.chunks.system}, mic ${recording.chunks.mic}`);
      stopRecordingNow('stalled', `no data for ${Math.round(silentFor / 1000)} s`);
      return;
    }
    const free = health.freeBytes(store.root());
    const verdict = diskVerdict(free);
    if (verdict === 'critical' && free !== null) {
      log.error('disk', `Only ${health.gigabytes(free)} free. Stopping the recording so the files are not damaged.`);
      new Notification({ title: 'Recording stopped', body: `This PC is almost out of space (${health.gigabytes(free)} left). What was recorded is saved.` }).show();
      stopRecordingNow('diskFull', `${health.gigabytes(free)} free`);
    } else if (verdict === 'low' && free !== null && !lowDiskShown) {
      lowDiskShown = true;
      log.warn('disk', `Free space is getting low: ${health.gigabytes(free)}`);
      new Notification({ title: 'Low on disk space', body: `${health.gigabytes(free)} left. A long recording could be cut short.` }).show();
    }
  }, 15_000).unref();
}

function watchPower(): void {
  powerMonitor.on('suspend', () => {
    log.info('power', 'The PC is going to sleep');
    if (recording) {
      lastSleepStop = { app: recording.app, title: recording.title, at: Date.now() };
      log.warn('power', 'Stopping the recording before sleep so it is saved');
      stopRecordingNow('sleep', 'the PC went to sleep');
    }
  });
  powerMonitor.on('resume', () => {
    log.info('power', 'The PC woke up');
    setTimeout(() => {
      if (lastSleepStop && Date.now() - lastSleepStop.at < 30 * 60_000 && detected && !recording) {
        const slept = lastSleepStop;
        lastSleepStop = null;
        log.info('power', 'The call is still going after waking, so recording again');
        startRecordingNow({ app: slept.app, title: slept.title });
      }
    }, 10_000);
  });
}

/** A call still marked as recording or processing was cut off. Keep what was saved and write the transcript now. */
function recoverInterrupted(unclean: boolean): void {
  const cutOff = ledger.closeOpenAsCrashed();
  let salvaged = 0;
  for (const call of store.listCalls()) {
    if (call.status !== 'recording' && call.status !== 'processing') continue;
    const dir = store.folder(call.id);
    const hasAudio = ['system.webm', 'mic.webm'].some((f) => { try { return fs.statSync(path.join(dir, f)).size > 1000; } catch { return false; } });
    if (hasAudio) {
      salvaged += 1;
      log.warn('recorder', `Recovering the interrupted call ${call.id}`);
      call.error = undefined;
      call.summary = call.summary || '';
      store.writeCall(call);
      void processCall(call.id, (m) => library?.webContents.send('progress', call.id, m)).then(changed);
    } else {
      call.status = 'error';
      call.error = 'The app closed before anything was recorded for this call.';
      store.writeCall(call);
    }
  }
  if (unclean || cutOff.length) {
    for (const entry of cutOff) log.error('recorder', `Recording ${entry.id} was cut off by a crash or a power cut`);
    new Notification({
      title: 'Meeting Agent closed unexpectedly',
      body: salvaged ? 'I kept what was recorded and I am writing the transcript. Please send a report from Settings so this can be fixed.' : 'It has been logged. If it keeps happening, send a report from Settings.'
    }).show();
  }
}

app.whenReady().then(() => {
  parakeet.configure({ modelsDir: path.join(app.getPath('userData'), 'models') });
  const previous = beginSession(app.getVersion());
  log.info('session', `──────── Meeting Agent ${app.getVersion()} started ────────`);
  log.info('session', health.machineLine());
  const free = health.freeBytes(store.root());
  log.info('session', `Free disk space: ${free === null ? 'unknown' : health.gigabytes(free)}`);
  if (previous) log.warn('session', `The previous run (started ${previous.startedAt}, version ${previous.version || 'unknown'}) did not quit cleanly. It crashed, was force-quit, or the PC lost power.`);

  setupCapture();
  setupIpc();
  createPanel();
  createTray();
  registerShortcuts();
  startWatching();
  openLibrary();
  watchRecording();
  watchPower();
  recoverInterrupted(previous !== null);
  parakeet.onState((s) => library?.webContents.send('speech:state', { ...s, text: parakeet.describe(s), installed: parakeet.isInstalled() }));
  updater.start((state, remind) => {
    library?.webContents.send('update:state', state);
    if (state.kind === 'available' && remind) {
      const n = new Notification({ title: `Meeting Agent ${state.version} is ready`, body: state.headline || 'Click to see what is new.' });
      n.on('click', () => openLibrary('settings'));
      n.show();
    }
  });
  // Fetch the speech model in the background so the first call is not delayed by it.
  setTimeout(() => { parakeet.prepare().catch(() => undefined); }, 15_000).unref();
});

app.on('before-quit', () => {
  if (recording) {
    log.warn('app', 'The app is quitting while recording');
    ledger.finish(recording.id, 'quit', 'The app was quit while recording.');
  }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); log.info('session', 'Quit normally.'); endSession(); });
// Stay in the tray when the windows are closed, so calls are still noticed.
app.on('window-all-closed', () => undefined);
