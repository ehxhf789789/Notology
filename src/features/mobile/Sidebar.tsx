/**
 * MobileSidebar — 260px sidebar with i18n support.
 */
import { useState, useCallback } from 'react';
import {
  Calendar, FileText, Search, Settings,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { t } from '../../core/utils/i18n';
import type { TabId } from './TabBar';
import type { LanguageSetting } from '../../core/utils/i18n';

interface SidebarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  language?: LanguageSetting;
}

const NAV_ITEMS: { id: TabId; icon: typeof Calendar; key: string }[] = [
  { id: 'calendar', icon: Calendar, key: 'mCalendar' },
  { id: 'notes', icon: FileText, key: 'mNotes' },
  { id: 'search', icon: Search, key: 'mSearch' },
];

export default function MobileSidebar({ activeTab, onChange, language = 'ko' }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed(c => !c), []);

  return (
    <aside className={`mobile-sidebar ${collapsed ? 'mobile-sidebar--collapsed' : ''}`}>
      <div className="mobile-sidebar-header">
        {!collapsed && <span className="mobile-sidebar-logo">Notology</span>}
        <button className="mobile-sidebar-toggle" onClick={toggle} aria-label="Toggle sidebar">
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
      <div className="mobile-sidebar-sep" />
      <nav className="mobile-sidebar-nav">
        {NAV_ITEMS.map(({ id, icon: Icon, key }) => (
          <button
            key={id}
            className={`mobile-sidebar-item ${activeTab === id ? 'active' : ''}`}
            onClick={() => onChange(id)}
          >
            <Icon size={20} strokeWidth={activeTab === id ? 2.2 : 1.8} />
            {!collapsed && <span className="mobile-sidebar-item-label">{t(key, language)}</span>}
          </button>
        ))}
      </nav>
      <div className="mobile-sidebar-spacer" />
      <div className="mobile-sidebar-sep" />
      <button
        className={`mobile-sidebar-item mobile-sidebar-item--bottom ${activeTab === 'settings' ? 'active' : ''}`}
        onClick={() => onChange('settings')}
      >
        <Settings size={20} strokeWidth={activeTab === 'settings' ? 2.2 : 1.8} />
        {!collapsed && <span className="mobile-sidebar-item-label">{t('mSettings', language)}</span>}
      </button>
    </aside>
  );
}
