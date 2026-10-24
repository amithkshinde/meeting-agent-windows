import { execFile } from 'node:child_process';
import { OpenWindow, parseWindowList } from '../shared/detect';

const SCRIPT =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { \"$($_.ProcessName)|$($_.MainWindowTitle)\" }";

/** Lists every open window as "process|title". Takes about a third of a second. */
export function listWindows(): Promise<OpenWindow[]> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { timeout: 8000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error ? [] : parseWindowList(stdout)));
  });
}
