/**
 * TabBar — Adaptive navigation bar with i18n.
 */
import { Calendar, FileText, MessageCircle, Search, Settings } from 'lucide-react';
import { t } from '../../../core/utils/i18n';
import type { NavigationMode } from '../../../hooks/useResponsiveLayout';
import type { LanguageSetting } from '../../../core/utils/i18n';

/* v7 3단계: 모바일에 dobbin 이 아예 없었다 (감사 2026-09-08 — features/mobile
   에서 grep "dobbin" 0건). 사서가 폰에서 안 보이면 관리자가 아니다. */
export type TabId = 'calendar' | 'dobbin' | 'notes' | 'search' | 'settings';

interface TabBarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  mode?: NavigationMode;
  language?: LanguageSetting;
}

const TAB_KEYS: Record<TabId, string> = {
  calendar: 'mCalendar',
  dobbin: 'mDobbin',
  notes: 'mNotes',
  search: 'mSearch',
  settings: 'mSettings',
};

const TAB_ICONS: Record<TabId, typeof Calendar> = {
  calendar: Calendar,
  dobbin: MessageCircle,
  notes: FileText,
  search: Search,
  settings: Settings,
};

const TAB_ORDER: TabId[] = ['calendar', 'dobbin', 'notes', 'search', 'settings'];

export function TabBar({ activeTab, onChange, mode = 'bottom-tab', language = 'ko' }: TabBarProps) {
  const isRail = mode === 'rail';
  const isCompact = mode === 'bottom-tab-compact';
  const iconSize = isRail ? 24 : isCompact ? 18 : 22;

  return (
    <nav className={`mobile-tabbar mobile-tabbar--${mode}`}>
      {TAB_ORDER.map(id => {
        const Icon = TAB_ICONS[id];
        return (
          <button
            key={id}
            className={`mobile-tabbar-item ${activeTab === id ? 'active' : ''}`}
            onClick={() => onChange(id)}
          >
            <Icon size={iconSize} strokeWidth={activeTab === id ? 2.2 : 1.8} />
            {mode !== 'rail' && (
              <span className="mobile-tabbar-label">{t(TAB_KEYS[id], language)}</span>
            )}
            {activeTab === id && (mode === 'bottom-tab' || isCompact) && (
              <span className="mobile-tabbar-indicator" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
