/**
 * TabBar — Adaptive navigation bar with i18n.
 */
import { Calendar, FileText, Search, Settings } from 'lucide-react';
import { t } from '../../../core/utils/i18n';
import type { NavigationMode } from '../../../hooks/useResponsiveLayout';
import type { LanguageSetting } from '../../../core/utils/i18n';

export type TabId = 'calendar' | 'notes' | 'search' | 'settings';

interface TabBarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  mode?: NavigationMode;
  language?: LanguageSetting;
}

const TAB_KEYS: Record<TabId, string> = {
  calendar: 'mCalendar',
  notes: 'mNotes',
  search: 'mSearch',
  settings: 'mSettings',
};

const TAB_ICONS: Record<TabId, typeof Calendar> = {
  calendar: Calendar,
  notes: FileText,
  search: Search,
  settings: Settings,
};

const TAB_ORDER: TabId[] = ['calendar', 'notes', 'search', 'settings'];

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
