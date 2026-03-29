import { parse, stringify } from 'yaml';
import type { NoteFrontmatter } from '../types';

export function parseFrontmatter(raw: string): NoteFrontmatter {
  try {
    const parsed = parse(raw) as Record<string, unknown>;
    return {
      created: String(parsed.created || ''),
      modified: String(parsed.modified || ''),
      title: parsed.title as string | undefined,
      type: parsed.type as string | undefined,
      cssclasses: parsed.cssclasses as string[] | undefined,
      tags: parsed.tags as string[] | undefined,
      ...parsed,
    };
  } catch {
    return {
      created: '',
      modified: '',
    };
  }
}

export function serializeFrontmatter(fm: NoteFrontmatter): string {
  // Filter out undefined values
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return stringify(clean, { lineWidth: 0 }).trim();
}

export function computeLevel(folderPath: string, vaultRoot: string): number {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedRoot = vaultRoot.replace(/\\/g, '/').replace(/\/$/, '');

  const relative = normalized.replace(normalizedRoot, '').replace(/^\//, '');
  if (!relative) return 0;

  return relative.split('/').filter(Boolean).length;
}

export function getCurrentTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  // Get timezone offset in minutes and convert to ±HH:MM format
  const offsetMinutes = -now.getTimezoneOffset(); // Negative because getTimezoneOffset returns UTC-local
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetStr = `${offsetSign}${pad(offsetHours)}:${pad(offsetMins)}`;

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetStr}`;
}
