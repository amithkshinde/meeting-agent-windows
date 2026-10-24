import * as fs from 'node:fs';
import * as path from 'node:path';

export class AIError extends Error {
  constructor(message: string, public kind: 'key' | 'quota' | 'other') {
    super(message);
  }
}

const GEMINI = 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-flash';
const CLAUDE_MODEL = 'claude-sonnet-5-5';

export function isClaudeKey(key: string): boolean {
  return key.startsWith('sk-ant-');
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID/.test(text)) {
    throw new AIError('The AI key was rejected. Paste a new one in Settings.', 'key');
  }
  if (res.status === 429) {
    throw new AIError('The free AI limit for today is used up. Try again tomorrow, or switch to a Claude key.', 'quota');
  }
  throw new AIError(`The AI service returned an error (${res.status}). ${text.slice(0, 200)}`, 'other');
}

/** Text in, text out. Claude keys go to Claude, anything else to Gemini. */
export async function complete(key: string, system: string, prompt: string, json = false, maxTokens = 4096): Promise<string> {
  if (isClaudeKey(key)) {
    const res = await check(await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] })
    }));
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? []).map((c) => c.text ?? '').join('');
  }
  const res = await check(await fetch(`${GEMINI}/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) }
    })
  }));
  return geminiText(await res.json());
}

function geminiText(data: unknown): string {
  const parts = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

/** Uploads an audio file to Gemini's file store and asks it to transcribe. Gemini keys only. */
export async function transcribe(key: string, file: string, instruction: string, mime = 'audio/ogg'): Promise<string> {
  if (isClaudeKey(key)) {
    throw new AIError('Claude cannot listen to audio yet. Add a free Gemini key in Settings for transcripts.', 'key');
  }
  const bytes = fs.readFileSync(file);
  const start = await check(await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: path.basename(file) } })
  }));
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new AIError('The AI service did not accept the audio upload.', 'other');
  const done = await check(await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes
  }));
  const info = (await done.json()) as { file?: { uri?: string; mimeType?: string } };
  const uri = info.file?.uri;
  if (!uri) throw new AIError('The AI service did not return the uploaded file.', 'other');

  const res = await check(await fetch(`${GEMINI}/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ fileData: { mimeType: info.file?.mimeType ?? mime, fileUri: uri } }, { text: instruction }] }],
      generationConfig: { maxOutputTokens: 32768, temperature: 0 }
    })
  }));
  return geminiText(await res.json());
}
