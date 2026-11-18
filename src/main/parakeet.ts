import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Token, Utterance, splitAtSilence, utterances } from '../shared/speech';
import { log } from './log';

/**
 * Parakeet speech recognition (NVIDIA Parakeet TDT 0.6B v3, int8) run on this PC through sherpa-onnx.
 * The model is about 650 MB and is downloaded once. After that nothing leaves the PC.
 * English and 24 other European languages. Hindi is not supported.
 */
const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`;
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];

export type SpeechState = { kind: 'idle' } | { kind: 'downloading'; fraction: number; step: string } | { kind: 'ready' } | { kind: 'failed'; message: string };

let modelsDir = path.join(os.homedir(), '.meeting-agent-models');
let state: SpeechState = { kind: 'idle' };
let recognizer: any = null;
let idleTimer: NodeJS.Timeout | null = null;
let preparing: Promise<void> | null = null;
const listeners = new Set<(s: SpeechState) => void>();

export function configure(options: { modelsDir: string }): void {
  modelsDir = options.modelsDir;
}

export const getState = (): SpeechState => state;
export function onState(fn: (s: SpeechState) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function setState(next: SpeechState): void {
  state = next;
  for (const fn of listeners) fn(next);
}

export function describe(s: SpeechState = state): string {
  switch (s.kind) {
    case 'idle': return isInstalled() ? 'Parakeet: model downloaded, loads when needed' : 'Parakeet: not downloaded yet';
    case 'downloading': return `Parakeet: ${s.step} (${Math.round(s.fraction * 100)}%)`;
    case 'ready': return 'Parakeet: ready (runs on this PC)';
    case 'failed': return `Parakeet: unavailable (${s.message})`;
  }
}

const modelFolder = (): string => path.join(modelsDir, MODEL_NAME);
export const isInstalled = (): boolean => FILES.every((f) => fs.existsSync(path.join(modelFolder(), f)));

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (error, _out, err) => (error ? reject(new Error(`${cmd} failed: ${err || error.message}`)) : resolve()));
  });
}

async function download(): Promise<void> {
  fs.mkdirSync(modelsDir, { recursive: true });
  const archive = path.join(modelsDir, `${MODEL_NAME}.tar.bz2.part`);
  log.info('parakeet', `Downloading the speech model to ${modelsDir}`);
  setState({ kind: 'downloading', fraction: 0, step: 'downloading the speech model' });
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastLogged = -1;
  const source = Readable.fromWeb(res.body as any);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const fraction = total ? Math.min(0.95, (received / total) * 0.95) : 0;
    setState({ kind: 'downloading', fraction, step: 'downloading the speech model' });
    const step = Math.floor(fraction * 10);
    if (step !== lastLogged) { lastLogged = step; log.info('parakeet', `Model download ${step * 10}%`); }
  });
  await pipeline(source, fs.createWriteStream(archive));
  if (total && received < total) throw new Error('the download was cut short');

  setState({ kind: 'downloading', fraction: 0.96, step: 'unpacking' });
  const staging = path.join(modelsDir, 'unpack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // Windows 10 and 11 include tar.exe, which reads .tar.bz2.
  await run('tar', ['-xjf', archive, '-C', staging]);
  fs.rmSync(modelFolder(), { recursive: true, force: true });
  fs.renameSync(path.join(staging, MODEL_NAME), modelFolder());
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  log.info('parakeet', 'The speech model is installed');
}

function load(): void {
  if (recognizer) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require('sherpa-onnx-node');
  const dir = modelFolder();
  const started = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer'
    }
  });
  log.info('parakeet', `Model loaded in ${((Date.now() - started) / 1000).toFixed(1)} s (${os.cpus()[0]?.model ?? 'cpu'})`);
}

/** Downloads (first time only) and loads the model. Safe to call many times. */
export function prepare(): Promise<void> {
  if (recognizer) { touch(); return Promise.resolve(); }
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      if (!isInstalled()) await download();
      setState({ kind: 'downloading', fraction: 0.99, step: 'loading' });
      load();
      setState({ kind: 'ready' });
      touch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recognizer = null;
      setState({ kind: 'failed', message });
      log.error('parakeet', `Could not set up Parakeet: ${message}`);
      throw error;
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/** The model uses about 1 GB of memory, so let it go a few minutes after the last call is finished. */
function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    recognizer = null;
    setState({ kind: 'idle' });
    log.info('parakeet', 'Released the speech model from memory');
  }, 5 * 60_000);
  idleTimer.unref?.();
}

const loud = (samples: Float32Array): boolean => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += 16) { sum += samples[i] * samples[i]; n++; }
  return n > 0 && Math.sqrt(sum / n) > 0.0015;
};

/** Reads 16 kHz samples and returns sentences, with times in seconds from the start of the samples. */
export async function transcribe(samples: Float32Array, onProgress?: (fraction: number) => void): Promise<Utterance[]> {
  await prepare();
  const pieces = splitAtSilence(samples, 16000);
  const tokens: Token[] = [];
  let done = 0;
  for (const [from, to] of pieces) {
    const chunk = samples.subarray(from, to);
    if (loud(chunk)) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: chunk });
      await recognizer.decodeAsync(stream);
      const result = recognizer.getResult(stream) as { tokens?: string[]; timestamps?: number[]; durations?: number[] };
      const offset = from / 16000;
      (result.tokens ?? []).forEach((text, i) => {
        const start = (result.timestamps?.[i] ?? 0) + offset;
        tokens.push({ text, start, end: start + (result.durations?.[i] ?? 0.08) });
      });
    }
    done += to - from;
    onProgress?.(done / Math.max(1, samples.length));
  }
  touch();
  return utterances(tokens);
}
