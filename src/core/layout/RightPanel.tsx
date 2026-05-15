import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import {
  CalendarDays,
  Tag,
  MessageSquare,
  ListTree,
  FileText,
  ChevronLeft,
  ChevronRight,
  PanelRightClose,
  CheckSquare,
  MessageCircle,
} from 'lucide-react';
import { memoCommands } from '../services/tauriCommands';
import { useVaultPath } from '../stores/fileTreeStore';
import { refreshActions } from '../stores/refreshStore';
import { hoverActions } from '../../features/hover-windows/stores/hoverStore';
import { useCalendarRefreshTrigger } from '../stores/refreshStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore, useRightPanelTab, uiActions, type RightPanelTab } from '../stores/uiStore';
import { Slot, SlotRegistry } from '../infrastructure/slotRegistry';
import { t, tf } from '../utils/i18n';
import { loadComments, saveComments } from '../../features/comments/comments';
import { notifyMemoChanged } from '../utils/windowSync';
import type { CalendarMemo, CalendarViewMode } from '../types';
import { Tabs, TabList, Tab, TabPanel, EmptyState, IconButton, Tooltip } from '../../design-system/components';

interface RightPanelProps {
  width: number;
}

const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const getTodayString = (): string => formatDate(new Date());

const RightPanel = memo(function RightPanel({ width }: RightPanelProps) {
  const language = useSettingsStore(s => s.language);
  const setShowHoverPanel = useUIStore(s => s.setShowHoverPanel);
  const activeTab = useRightPanelTab();

  return (
    <div className="right-panel" style={{ width }}>
      <header className="right-panel-header">
        <div className="right-panel-header-left">
          <div className="right-panel-today-icon">
            <CalendarDays size={14} />
            <span className="right-panel-today-day">{new Date().getDate()}</span>
          </div>
          <div className="right-panel-today-info">
            <span className="right-panel-today-label">{t('today', language)}</span>
            <span className="right-panel-today-date">
              {new Date().toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', {
                month: 'short',
                weekday: 'short',
              })}
            </span>
          </div>
        </div>
        <IconButton
          icon={<PanelRightClose size={18} />}
          aria-label={t('close', language)}
          variant="ghost"
          size="sm"
          onClick={() => setShowHoverPanel(false)}
        />
      </header>

      <Tabs
        value={activeTab}
        onChange={(v) => uiActions.setRightPanelTab(v as RightPanelTab)}
        className="right-panel-tabs"
      >
        <TabList aria-label={t('rightPanelTabsLabel', language)} className="right-panel-tablist">
          <Tab value="calendar" icon={<CalendarDays size={14} />} title={t('rightPanelCalendar', language)}>
            {t('rightPanelCalendar', language)}
          </Tab>
          <Tab value="tags"     icon={<Tag size={14} />}          title={t('rightPanelTags', language)}>
            {t('rightPanelTags', language)}
          </Tab>
          <Tab value="comments" icon={<MessageSquare size={14} />} title={t('rightPanelComments', language)}>
            {t('rightPanelComments', language)}
          </Tab>
          <Tab value="outline"  icon={<ListTree size={14} />}     title={t('rightPanelOutline', language)}>
            {t('rightPanelOutline', language)}
          </Tab>
          <Tab value="metadata" icon={<FileText size={14} />}     title={t('rightPanelMetadata', language)}>
            {t('rightPanelMetadata', language)}
          </Tab>
        </TabList>

        <TabPanel value="calendar"><CalendarTabContent /></TabPanel>
        <TabPanel value="tags"><SlotOrEmpty name="right-panel-tags" perNote /></TabPanel>
        <TabPanel value="comments"><SlotOrEmpty name="right-panel-comments" perNote /></TabPanel>
        <TabPanel value="outline"><SlotOrEmpty name="right-panel-outline" perNote /></TabPanel>
        <TabPanel value="metadata"><SlotOrEmpty name="right-panel-metadata" perNote /></TabPanel>
      </Tabs>
    </div>
  );
});

export default RightPanel;

/* ============================================================
   Slot-or-EmptyState wrapper for per-note tabs
   ------------------------------------------------------------
   Renders any feature components registered under the given
   slot name. If none are registered, falls back to an
   EmptyState explaining the panel is per-note.
   ============================================================ */
interface SlotOrEmptyProps {
  name: string;
  perNote?: boolean;
}
function SlotOrEmpty({ name, perNote }: SlotOrEmptyProps) {
  const entries = SlotRegistry._getSnapshot(name);
  const language = useSettingsStore(s => s.language);

  if (entries.length > 0) {
    return <div className="right-panel-tab-content"><Slot name={name} /></div>;
  }

  return (
    <div className="right-panel-tab-content right-panel-tab-empty">
      <EmptyState
        title={t(perNote ? 'rightPanelEmptyPerNoteTitle' : 'rightPanelEmptyTitle', language)}
        description={t(perNote ? 'rightPanelEmptyPerNoteDesc' : 'rightPanelEmptyDesc', language)}
      />
    </div>
  );
}

/* ============================================================
   CalendarTabContent — the original RightPanel.tsx calendar
   surface, lifted into its own component so it composes
   inside the new tab-row layout.
   ============================================================ */
function CalendarTabContent() {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const language = useSettingsStore(s => s.language);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(getTodayString());
  const [memos, setMemos] = useState<CalendarMemo[]>([]);
  const [viewMode, setViewMode] = useState<CalendarViewMode>('task');
  const [temporarilyResolved, setTemporarilyResolved] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (vaultPath) loadMemos();
  }, [vaultPath, calendarRefreshTrigger]);

  const loadMemos = async () => {
    if (!vaultPath) return;
    try {
      const result = await memoCommands.collectCalendarMemos(vaultPath);
      setMemos(result);
    } catch (e) {
      console.error('Failed to load calendar memos:', e);
    }
  };

  const filteredMemos = useMemo(() => memos.filter(m => {
    if (viewMode === 'task' && !m.isTask) return false;
    if (viewMode === 'memo' && m.isTask) return false;
    if (m.resolved && !temporarilyResolved.has(m.id)) return false;
    return true;
  }), [memos, viewMode, temporarilyResolved]);

  const memosByDate = useMemo(() => {
    const g = new Map<string, CalendarMemo[]>();
    filteredMemos.forEach(m => g.set(m.date, [...(g.get(m.date) || []), m]));
    return g;
  }, [filteredMemos]);

  const selectedDateMemos = useMemo(() => memosByDate.get(selectedDate) || [], [selectedDate, memosByDate]);

  const todayCounts = useMemo(() => {
    const today = getTodayString();
    const todayMemos = memos.filter(m => m.date === today && !m.resolved);
    return {
      taskCount: todayMemos.filter(m => m.isTask).length,
      memoCount: todayMemos.filter(m => !m.isTask).length,
    };
  }, [memos]);

  const calendarGrid = useMemo(() => {
    const y = currentDate.getFullYear();
    const m = currentDate.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const grid: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) grid.push(null);
    for (let d = 1; d <= days; d++) grid.push(d);
    return grid;
  }, [currentDate]);

  const changeMonth = (delta: number) => {
    setCurrentDate(prev => {
      const d = new Date(prev);
      d.setMonth(d.getMonth() + delta);
      return d;
    });
  };

  const handleDateClick = (day: number) => {
    const d = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    const dateStr = formatDate(d);
    setSelectedDate(dateStr);
    const dateMemos = memos.filter(m => m.date === dateStr && !m.resolved);
    const hasTasks = dateMemos.some(m => m.isTask);
    const hasMemos = dateMemos.some(m => !m.isTask);
    if (viewMode === 'task' && !hasTasks && hasMemos) setViewMode('memo');
    else if (viewMode === 'memo' && !hasMemos && hasTasks) setViewMode('task');
  };

  const handleMemoClick = (memo: CalendarMemo) => hoverActions.open(memo.notePath);

  const handleResolveToggle = useCallback(async (memo: CalendarMemo) => {
    setTemporarilyResolved(prev => {
      const next = new Set(prev);
      next.has(memo.id) ? next.delete(memo.id) : next.add(memo.id);
      return next;
    });
    try {
      const { comments, mtime } = await loadComments(memo.notePath);
      const updated = comments.map(c => c.id === memo.id ? { ...c, resolved: !c.resolved } : c);
      await saveComments(memo.notePath, updated, mtime);
      refreshActions.batchRefresh({ calendar: true });
      notifyMemoChanged(memo.notePath).catch(() => {});
    } catch (e) {
      console.error('Failed to toggle memo resolved state:', e);
    }
  }, []);

  const isToday = (day: number): boolean => {
    const today = new Date();
    return day === today.getDate()
      && currentDate.getMonth() === today.getMonth()
      && currentDate.getFullYear() === today.getFullYear();
  };

  const getMemoCountForDate = (day: number): number => {
    const d = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    return memosByDate.get(formatDate(d))?.length || 0;
  };

  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <div className="right-panel-tab-content right-panel-calendar-tab">
      <div className="right-panel-calendar">
        <div className="right-panel-calendar-nav">
          <button onClick={() => changeMonth(-1)} className="right-panel-nav-btn" aria-label={t('prevMonth', language)}>
            <ChevronLeft size={14} />
          </button>
          <span className="right-panel-month">
            {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
          </span>
          <button onClick={() => changeMonth(1)} className="right-panel-nav-btn" aria-label={t('nextMonth', language)}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="right-panel-calendar-grid">
          <div className="right-panel-weekdays">
            {dayNames.map((d, i) => <div key={i} className="right-panel-weekday">{d}</div>)}
          </div>
          <div className="right-panel-days">
            {calendarGrid.map((day, idx) => {
              if (day === null) return <div key={idx} className="right-panel-day empty" />;
              const count = getMemoCountForDate(day);
              const dateStr = formatDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), day));
              const selected = dateStr === selectedDate;
              const isTd = isToday(day);
              return (
                <div
                  key={idx}
                  className={`right-panel-day${isTd ? ' today' : ''}${selected ? ' selected' : ''}${count > 0 ? ' has-memos' : ''}`}
                  onClick={() => handleDateClick(day)}
                >
                  <span className="right-panel-day-number">{day}</span>
                  {count > 0 && <span className="right-panel-day-count">{count}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="right-panel-divider" />

      <div className="right-panel-memos">
        <div className="right-panel-memo-header">
          <div className="right-panel-memo-toggle">
            <button
              className={`right-panel-toggle-btn${viewMode === 'task' ? ' active' : ''}`}
              onClick={() => setViewMode('task')}
            >
              <CheckSquare size={12} />
              <span>{t('calendarTask', language)}</span>
              {todayCounts.taskCount > 0 && (
                <span className="right-panel-toggle-badge">{todayCounts.taskCount}</span>
              )}
            </button>
            <button
              className={`right-panel-toggle-btn${viewMode === 'memo' ? ' active' : ''}`}
              onClick={() => setViewMode('memo')}
            >
              <MessageCircle size={12} />
              <span>{t('calendarMemo', language)}</span>
              {todayCounts.memoCount > 0 && (
                <span className="right-panel-toggle-badge">{todayCounts.memoCount}</span>
              )}
            </button>
          </div>
          <span className="right-panel-memo-count">{selectedDateMemos.length}</span>
        </div>

        <div className="right-panel-memo-list">
          {selectedDateMemos.map(memo => (
            <div
              key={memo.id}
              className={`right-panel-memo-item${temporarilyResolved.has(memo.id) ? ' resolved' : ''}`}
              onClick={() => handleMemoClick(memo)}
            >
              <input
                type="checkbox"
                checked={temporarilyResolved.has(memo.id) || memo.resolved}
                onChange={(e) => { e.stopPropagation(); handleResolveToggle(memo); }}
                className="right-panel-memo-checkbox"
              />
              <div className="right-panel-memo-content">
                <div className="right-panel-memo-text">{memo.content}</div>
                <div className="right-panel-memo-meta">{memo.noteTitle}</div>
              </div>
            </div>
          ))}
          {selectedDateMemos.length === 0 && (
            <div className="right-panel-memo-empty">
              {viewMode === 'task' ? t('calendarNoTasks', language) : t('calendarNoMemos', language)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Exported hook (preserved API for collapsed-bar consumers)
   ============================================================ */
export function useTodayMemoCount(): { taskCount: number; memoCount: number; total: number } {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const [counts, setCounts] = useState({ taskCount: 0, memoCount: 0, total: 0 });

  useEffect(() => {
    if (!vaultPath) return;
    const load = async () => {
      try {
        const memos = await memoCommands.collectCalendarMemos(vaultPath);
        const today = getTodayString();
        const tm = memos.filter(m => m.date === today && !m.resolved);
        const taskCount = tm.filter(m => m.isTask).length;
        const memoCount = tm.filter(m => !m.isTask).length;
        setCounts({ taskCount, memoCount, total: taskCount + memoCount });
      } catch (e) {
        console.error('Failed to load memo counts:', e);
      }
    };
    load();
  }, [vaultPath, calendarRefreshTrigger]);

  return counts;
}
