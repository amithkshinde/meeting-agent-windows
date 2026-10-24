export interface Commitment {
  id: string;
  owner: string;
  text: string;
  due?: string;
  done: boolean;
  mine: boolean;
}

export interface Bookmark {
  t: number;      // seconds from the start of the recording
  note: string;
}

export type CallStatus = 'recording' | 'processing' | 'done' | 'error';

/** One call, saved as call.json inside its own folder. */
export interface CallRecord {
  id: string;
  startedAt: string;       // ISO date
  durationSec: number;
  app: string;             // "Google Meet", "Zoom", "Microsoft Teams", "Manual"
  title: string;
  project: string;
  status: CallStatus;
  error?: string;
  summary: string;
  decisions: string[];
  promises: Commitment[];
}

export interface Settings {
  userName: string;
  language: 'auto' | 'en' | 'hi' | 'hinglish';
  script: 'roman' | 'devanagari';
  watchCalls: boolean;
  hasKey: boolean;
  keyKind: 'none' | 'gemini' | 'claude';
}

export interface DetectedCall {
  app: string;
  title: string;
}

export interface SearchHit {
  kind: 'call' | 'moment' | 'promise';
  callId: string;
  title: string;
  detail: string;
  seek?: number;
}
