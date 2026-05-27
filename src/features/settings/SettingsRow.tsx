/**
 * Stage 5.0.6 (2026-05-17, HanBin) — SettingsRow primitive.
 *
 * Settings.tsx had 10+ instances of the same markup skeleton:
 *
 *   <div className="settings-row">
 *     <div className="settings-row-info">
 *       <span className="settings-row-label">{label}</span>
 *       <span className="settings-row-desc">{desc}</span>
 *     </div>
 *     {control}
 *   </div>
 *
 * Each row is a label + (optional) description + a control. Pulling the
 * skeleton into one primitive keeps spacing, alignment, and a11y
 * consistent across every section, and makes a future redesign of the
 * row (e.g. inline help icon, status badge, breaking control onto its
 * own line on narrow widths) a single edit.
 *
 * Pass the control via children. The label/description copy stays
 * caller-controlled — i18n resolution happens at the call site so this
 * primitive doesn't depend on the i18n module.
 */
import type { ReactNode } from 'react';

interface SettingsRowProps {
  label: string;
  description?: string;
  /** Control element(s): toggle button, select, input, action button. */
  children: ReactNode;
  /** Extra class on the outer row — used for special-case spacing
   *  (e.g. rows that need vertical layout for long descriptions). */
  className?: string;
}

export function SettingsRow({ label, description, children, className }: SettingsRowProps) {
  return (
    <div className={`settings-row${className ? ` ${className}` : ''}`}>
      <div className="settings-row-info">
        <span className="settings-row-label">{label}</span>
        {description && <span className="settings-row-desc">{description}</span>}
      </div>
      {children}
    </div>
  );
}

export default SettingsRow;
