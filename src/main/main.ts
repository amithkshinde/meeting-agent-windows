import { BrowserWindow, Menu, Notification, Tray, app, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CallDebouncer, matchCall } from '../shared/detect';
import { DetectedCall, Settings } from '../shared/types';
import { rename } from '../shared/transcript';
import { search } from '../shared/search';
import { markdown, fileName } from './exporter';
import * as feedback from './feedbackService';
import { processCall } from './pipeline';
import { clearKey, keyKind, loadKey, saveKey } from './secrets';
import * as store from './store';
import { listWindows } from './windows';

let panel: BrowserWindow | null = null;
let library: BrowserWindow | null = null;
let tray: Tray | null = null;

interface Recording {
  id: string;
  startedAt: number;
  streams: Record<string, fs.WriteStream>;
}
let recording: Recording | null = null;
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
    width: 340, height: 120, x: workArea.x + workArea.width - 360, y: workArea.y + workArea.height - 140,
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

function stopRecordingNow(): void {
  inPanel('window.__stopFromMain()');
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
        panel?.webContents.send('detected', detected);
        if (!recording) {
          showPanel();
          const n = new Notification({ title: `${detected.app} call detected`, body: 'Click to start recording.' });
          n.on('click', () => startRecordingNow(detected ?? undefined));
          n.show();
        }
      }
      if (result.ended) {
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

function setupIpc(): void {
  handle('rec:start', (appName: string, title: string) => {
    const call = store.newCall(appName, title);
    const dir = store.folder(call.id);
    recording = {
      id: call.id,
      startedAt: Date.now(),
      streams: {
        screen: fs.createWriteStream(path.join(dir, 'screen.webm')),
        system: fs.createWriteStream(path.join(dir, 'system.webm')),
        mic: fs.createWriteStream(path.join(dir, 'mic.webm'))
      }
    };
    changed();
    return { id: call.id };
  });

  ipcMain.on('rec:chunk', (_event, kind: string, data: ArrayBuffer) => {
    recording?.streams[kind]?.write(Buffer.from(data));
  });

  handle('rec:stop', async () => {
    const current = recording;
    if (!current) return;
    recording = null;
    await Promise.all(Object.values(current.streams).map((s) => new Promise<void>((resolve) => s.end(resolve))));
    const call = store.readCall(current.id);
    if (call) {
      call.durationSec = Math.round((Date.now() - current.startedAt) / 1000);
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
    panel.setBounds({ x: workArea.x + workArea.width - width - 20, y: workArea.y + workArea.height - height - 20, width, height });
  });
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
}

// MARK: start

app.whenReady().then(() => {
  setupCapture();
  setupIpc();
  createPanel();
  createTray();
  registerShortcuts();
  startWatching();
  openLibrary();
  // A call that was still being written when the app closed cannot be finished; mark it so it is not stuck.
  for (const call of store.listCalls()) {
    if (call.status === 'recording' || call.status === 'processing') {
      call.status = 'error';
      call.error = 'The app closed before this call was finished. Press Retry to try again.';
      store.writeCall(call);
    }
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
// Stay in the tray when the windows are closed, so calls are still noticed.
app.on('window-all-closed', () => undefined);
