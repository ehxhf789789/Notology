import { parse, stringify } from 'yaml';
import type { NoteFrontmatter, FacetedTags, LegacyFlatTags } from '../types';

// A64 (2026-08-27) — 실데이터의 행정 노트 15/15 가 `cssclasses: adm-type`
// **스칼라**다. yaml 은 이것을 문자열로 파싱하는데 캐스트만으로는 소비자
// (.find / .join — HoverEditor.tsx:850·875·1029, ContainerView.tsx:752)가
// 렌더 중에 죽어 hover 창에 색이 영영 안 든다. 소비자가 여럿이라 파싱 목
// 한 자리에서 목록으로 정규화한다.
function normalizeCssclasses(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return undefined;
}

export function parseFrontmatter(raw: string): NoteFrontmatter {
  try {
    const parsed = parse(raw) as Record<string, unknown>;
    return {
      created: String(parsed.created || ''),
      modified: String(parsed.modified || ''),
      title: parsed.title as string | undefined,
      type: parsed.type as string | undefined,
      // 11th hotfix (2026-05-17) — was `as string[] | undefined` which
      // misrepresented reality (yaml-parsed `tags` is a FacetedTags object
      // for current vaults, legacy flat array for old vaults). Polymorphic
      // union now matches the type declaration in core/types/index.ts.
      tags: parsed.tags as FacetedTags | LegacyFlatTags | undefined,
      ...parsed,
      // 🔴 스프레드 **뒤**여야 한다 — 앞에 두면 `...parsed` 가 도로 덮는다
      cssclasses: normalizeCssclasses(parsed.cssclasses),
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
