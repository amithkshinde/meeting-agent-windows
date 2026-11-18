export function parseVersion(text: string): number[] | null {
  const cleaned = text.trim().replace(/^(windows-|mac-)?v/i, '').split(/[-+]/)[0];
  const parts = cleaned.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return parts.length && parts.every((n) => Number.isFinite(n)) ? parts : null;
}

export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const isNewer = (latest: string, installed: string): boolean => compareVersions(latest, installed) === 1;

export interface ReleaseInfo { tag: string; page: string; notes: string; assets: { name: string; url: string }[] }

/** Reads GitHub's "latest release" answer. Drafts and pre-releases are ignored. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  const o = json as { tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: { name?: string; browser_download_url?: string }[] };
  if (!o || typeof o.tag_name !== 'string' || !parseVersion(o.tag_name) || o.draft || o.prerelease) return null;
  return {
    tag: o.tag_name,
    page: o.html_url ?? '',
    notes: o.body ?? '',
    assets: (o.assets ?? []).filter((a) => a.name && a.browser_download_url).map((a) => ({ name: a.name as string, url: a.browser_download_url as string }))
  };
}

/** The Windows installer: "MeetingAgent-Setup-<version>-x64.exe" (or arm64 on ARM PCs). */
export function pickInstaller(release: ReleaseInfo, arch: string): string | null {
  const wanted = arch === 'arm64' ? 'arm64' : 'x64';
  return release.assets.find((a) => /\.exe$/i.test(a.name) && a.name.toLowerCase().includes(wanted))?.url ?? null;
}

export function headline(notes: string): string {
  const line = notes.split(/\r?\n/).map((l) => l.replace(/^[#*\-\s]+/, '').trim()).find(Boolean) ?? '';
  return line.length > 110 ? line.slice(0, 110) + '…' : line;
}

export const shouldRemind = (last: number | null, now = Date.now()): boolean => last === null || now - last > 20 * 3600_000;
