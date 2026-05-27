/**
 * Stage 5.0.5a-β (2026-05-16, HanBin) — template body variable scan.
 *
 * Inspects a template body string for `{{token}}` markers, cross-references
 * each against TEMPLATE_VAR_CATALOG, and returns the user-input variables
 * (autoFill: false) that the NoteCreationWizard needs to surface as form
 * fields. Duplicates are collapsed to a single entry — same `{{email}}`
 * referenced 3 times in the body → 1 input field.
 */
import { Type as TypeIcon } from 'lucide-react';
import {
  TEMPLATE_VAR_CATALOG,
  TEMPLATE_VAR_CATEGORIES,
  type TemplateVarSpec,
  type TemplateVarCategory,
} from './templateVarCatalog';

const TOKEN_REGEX = /\{\{([\w-]+)\}\}/g;

/** Return user-input variable specs referenced in the body (deduped, in
 *  catalog order so categories cluster naturally).
 *
 *  Hotfix (2026-05-17, HanBin) — unknown tokens (anything outside
 *  TEMPLATE_VAR_CATALOG) are now emitted as synthetic specs under the
 *  `'custom'` category instead of being silently dropped. The
 *  NoteTemplateEditor's Fields tab already promised this behavior
 *  ("wizard에서 plain text 입력 칸으로 처리") but the wizard side wasn't
 *  honoring it — templates with author-defined variables like
 *  `{{my-field}}` produced an empty wizard form. */
export function scanUserInputVars(body: string): TemplateVarSpec[] {
  if (!body) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_REGEX.exec(body)) !== null) {
    const tok = `{{${match[1]}}}`;
    if (seen.has(tok)) continue;
    seen.add(tok);
    found.push(tok);
  }
  if (found.length === 0) return [];

  // Built-in catalog specs (autoFill: false) in catalog order so categories
  // cluster naturally. Auto-fill tokens are excluded — they don't need a form.
  const builtIn = TEMPLATE_VAR_CATALOG.filter(spec => !spec.autoFill && seen.has(spec.token));
  const builtInTokens = new Set(builtIn.map(s => s.token));
  const autoFillTokens = new Set(
    TEMPLATE_VAR_CATALOG.filter(s => s.autoFill).map(s => s.token),
  );

  // Unknown tokens — emit a synthetic spec per token, preserving discovery
  // order so the wizard renders them in the same sequence they appear in
  // the body. Icon defaults to Type (text-input glyph).
  const customSpecs: TemplateVarSpec[] = [];
  for (const tok of found) {
    if (builtInTokens.has(tok) || autoFillTokens.has(tok)) continue;
    customSpecs.push({
      token: tok,
      // Synthetic i18n key: render the raw token name as the label.
      // TitleInputModal's t() fallback returns the key string itself when
      // the translation is missing, so passing the bare token name gives a
      // sensible label without authoring a new i18n entry per template.
      labelI18n: tok.replace(/^\{\{|\}\}$/g, ''),
      Icon: TypeIcon,
      category: 'custom',
      autoFill: false,
    });
  }

  return [...builtIn, ...customSpecs];
}

/** Group user-input variables by category for the wizard form layout. */
export interface VarGroup {
  category: TemplateVarCategory;
  labelI18n: string;
  entries: TemplateVarSpec[];
}

export function groupVarsByCategory(specs: TemplateVarSpec[]): VarGroup[] {
  const groups: VarGroup[] = [];
  for (const cat of TEMPLATE_VAR_CATEGORIES) {
    const entries = specs.filter(s => s.category === cat.id);
    if (entries.length > 0) {
      groups.push({ category: cat.id, labelI18n: cat.labelI18n, entries });
    }
  }
  return groups;
}

/** Whether the body contains at least one user-input variable. Used by the
 *  Ctrl+N flow to decide between TitleInputModal (no vars) and the full
 *  NoteCreationWizard. */
export function hasUserInputVars(body: string): boolean {
  return scanUserInputVars(body).length > 0;
}

/**
 * Build a substitution map for ALL catalog variables given form values +
 * the creation context. Auto-fill variables (date/year/today/etc.) are
 * computed from `now` and `context`. User-input variables come from the
 * `formValues` map. The returned object is suitable for passing to the
 * existing `applyTemplateVariables(body, vars)` helper.
 *
 * v15 (2026-05-16, HanBin) — covers all 29 catalog tokens. Previously
 * only a handful were substituted (date / year / title); the rest stayed
 * as literal `{{...}}` text in the note body.
 */
export interface CreationContext {
  title: string;
  prefix?: string;
  type?: string;
  filename?: string;
  path?: string;
  id?: string;
}

export function buildSubstitutionMap(
  formValues: Record<string, string>,
  context: CreationContext,
  now: Date = new Date(),
): Record<string, string> {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const timeStr = `${hh}:${min}`;
  const datetimeStr = `${dateStr} ${timeStr}`;
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const weekday = weekdays[now.getDay()];

  // Auto-fill first (lowest priority — form values override below)
  const subs: Record<string, string> = {
    title: context.title || '',
    date: dateStr,
    time: timeStr,
    datetime: datetimeStr,
    today: dateStr,
    year: String(yyyy),
    month: mm,
    day: dd,
    weekday,
    hour: hh,
    minute: min,
    prefix: context.prefix || '',
    type: context.type || '',
    filename: context.filename || context.title || '',
    path: context.path || '',
    id: context.id || '',
  };

  // Form-collected user-input values override / fill the rest.
  for (const [k, v] of Object.entries(formValues)) {
    if (v !== undefined && v !== null) subs[k] = String(v);
  }

  return subs;
}
