import { safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { root } from './store';

/** The AI key is encrypted with Windows DPAPI (via Electron safeStorage) and never leaves this process. */
const file = () => path.join(root(), '.key');

export function saveKey(key: string): void {
  const clean = key.trim();
  if (!clean) return;
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file(), safeStorage.encryptString(clean));
  else throw new Error('Windows could not provide secure storage for the key.');
}

export function loadKey(): string {
  try {
    return safeStorage.decryptString(fs.readFileSync(file()));
  } catch {
    return '';
  }
}

export function clearKey(): void {
  try { fs.unlinkSync(file()); } catch { /* nothing to remove */ }
}

export function keyKind(key: string): 'none' | 'gemini' | 'claude' {
  if (!key) return 'none';
  return key.startsWith('sk-ant-') ? 'claude' : 'gemini';
}
