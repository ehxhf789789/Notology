import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, PanelRightClose, CheckSquare, MessageSquare } from 'lucide-react';
import { memoCommands } from '../../services/tauriCommands';
import { useVaultPath } from '../../stores/zustand/fileTreeStore';
import { hoverActions } from '../../stores/zustand/hoverStore';
import { useCalendarRefreshTrigger } from '../../stores/zustand/refreshStore';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { useUIStore } from '../../stores/zustand/uiStore';
import { t, tf } from '../../utils/i18n';
import type { CalendarMemo, CalendarViewMode } from '../../types';

interface RightPanelProps {
  width: number;
}

// Format date to YYYY-MM-DD
const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Get today's date string
const getTodayString = (): string => formatDate(new Date());

const RightPanel = memo(function RightPanel({ width }: RightPanelProps) {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const language = useSettingsStore(s => s.language);
  const setShowHoverPanel = useUIStore(s => s.setShowHoverPanel);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(getTodayString());
  const [memos, setMemos] = useState<CalendarMemo[]>([]);
  const [viewMode, setViewMode] = useState<CalendarViewMode>('task');
  const [temporarilyResolved, setTemporarilyResolved] = useState<Set<string>>(new Set());

  // Load memos when vault changes or refresh trigger changes
  useEffect(() => {
    if (vaultPath) {
      loadMemos();
    }
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

  // Filter memos by view mode and resolved status
  const filteredMemos = useMemo(() => {
    return memos.filter(memo => {
      if (viewMode === 'task' && !memo.isTask) return false;
      if (viewMode === 'memo' && memo.isTask) return false;
      if (memo.resolved && !temporarilyResolved.has(memo.id)) return false;
      return true;
    });
  }, [memos, viewMode, temporarilyResolved]);

  // Group memos by date
  const memosByDate = useMemo(() => {
    const grouped = new Map<string, CalendarMemo[]>();
    filteredMemos.forEach(memo => {
      const existing = grouped.get(memo.date) || [];
      grouped.set(memo.date, [...existing, memo]);
    });
    return grouped;
  }, [filteredMemos]);

  // Get memos for selected date
  const selectedDateMemos = useMemo(() => {
    return memosByDate.get(selectedDate) || [];
  }, [selectedDate, memosByDate]);

  // Get today's task and memo counts (for badge display)
  const todayCounts = useMemo(() => {
    const today = getTodayString();
    const todayMemos = memos.filter(m => m.date === today && !m.resolved);
    return {
      taskCount: todayMemos.filter(m => m.isTask).length,
      memoCount: todayMemos.filter(m => !m.isTask).length,
    };
  }, [memos]);

  // Calendar grid calculation
  const calendarGrid = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const firstDayOfWeek = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const grid: (number | null)[] = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      grid.push(null);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      grid.push(day);
    }
    return grid;
  }, [currentDate]);

  const changeMonth = (delta: number) => {
    setCurrentDate(prev => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + delta);
      return newDate;
    });
  };

  const handleDateClick = (day: number) => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const date = new Date(year, month, day);
    setSelectedDate(formatDate(date));
  };

  const handleMemoClick = (memo: CalendarMemo) => {
    hoverActions.open(memo.notePath);
  };

  const handleResolveToggle = (memoId: string) => {
    setTemporarilyResolved(prev => {
      const newSet = new Set(prev);
      if (newSet.has(memoId)) {
        newSet.delete(memoId);
      } else {
        newSet.add(memoId);
      }
      return newSet;
    });
  };

  const isToday = (day: number): boolean => {
    const today = new Date();
    return (
      day === today.getDate() &&
      currentDate.getMonth() === today.getMonth() &&
      currentDate.getFullYear() === today.getFullYear()
    );
  };

  const getMemoCountForDate = (day: number): number => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const date = new Date(year, month, day);
    const dateStr = formatDate(date);
    return memosByDate.get(dateStr)?.length || 0;
  };

  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <div className="right-panel" style={{ width }}>
      {/* Header - Shows today's date */}
      <div className="right-panel-header">
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
                weekday: 'short'
              })}
            </span>
          </div>
        </div>
        <button
          className="right-panel-close"
          onClick={() => setShowHoverPanel(false)}
          title={t('close', language)}
        >
          <PanelRightClose size={18} />
        </button>
      </div>

      {/* Calendar Section - Top 50% */}
      <div className="right-panel-calendar">
        {/* Month Navigation */}
        <div className="right-panel-calendar-nav">
          <button onClick={() => changeMonth(-1)} className="right-panel-nav-btn">
            <ChevronLeft size={14} />
          </button>
          <span className="right-panel-month">
            {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
          </span>
          <button onClick={() => changeMonth(1)} className="right-panel-nav-btn">
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Compact Calendar Grid */}
        <div className="right-panel-calendar-grid">
          <div className="right-panel-weekdays">
            {dayNames.map((day, i) => (
              <div key={i} className="right-panel-weekday">{day}</div>
            ))}
          </div>
          <div className="right-panel-days">
            {calendarGrid.map((day, index) => {
              const memoCount = day !== null ? getMemoCountForDate(day) : 0;
              const dateStr = day !== null
                ? formatDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), day))
                : '';
              const isSelected = dateStr === selectedDate;
              const isTodayDate = day !== null && isToday(day);

              return (
                <div
                  key={index}
                  className={`right-panel-day ${day === null ? 'empty' : ''} ${isTodayDate ? 'today' : ''} ${isSelected ? 'selected' : ''} ${memoCount > 0 ? 'has-memos' : ''}`}
                  onClick={() => day !== null && handleDateClick(day)}
                >
                  {day !== null && (
                    <>
                      <span className="right-panel-day-number">{day}</span>
                      {memoCount > 0 && (
                        <span className="right-panel-day-count">{memoCount}</span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="right-panel-divider" />

      {/* Memo List Section - Bottom 50% */}
      <div className="right-panel-memos">
        {/* View Mode Toggle */}
        <div className="right-panel-memo-header">
          <div className="right-panel-memo-toggle">
            <button
              className={`right-panel-toggle-btn ${viewMode === 'task' ? 'active' : ''}`}
              onClick={() => setViewMode('task')}
            >
              <CheckSquare size={12} />
              <span>{t('calendarTask', language)}</span>
              {todayCounts.taskCount > 0 && (
                <span className="right-panel-toggle-badge">{todayCounts.taskCount}</span>
              )}
            </button>
            <button
              className={`right-panel-toggle-btn ${viewMode === 'memo' ? 'active' : ''}`}
              onClick={() => setViewMode('memo')}
            >
              <MessageSquare size={12} />
              <span>{t('calendarMemo', language)}</span>
              {todayCounts.memoCount > 0 && (
                <span className="right-panel-toggle-badge">{todayCounts.memoCount}</span>
              )}
            </button>
          </div>
          <span className="right-panel-memo-count">
            {selectedDateMemos.length}
          </span>
        </div>

        {/* Memo Items */}
        <div className="right-panel-memo-list">
          {selectedDateMemos.map(memo => (
            <div
              key={memo.id}
              className={`right-panel-memo-item ${temporarilyResolved.has(memo.id) ? 'resolved' : ''}`}
              onClick={() => handleMemoClick(memo)}
            >
              <input
                type="checkbox"
                checked={temporarilyResolved.has(memo.id) || memo.resolved}
                onChange={(e) => {
                  e.stopPropagation();
                  handleResolveToggle(memo.id);
                }}
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
});

export default RightPanel;

// Export hook for getting today's memo count (used by collapsed bar)
export function useTodayMemoCount(): { taskCount: number; memoCount: number; total: number } {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const [counts, setCounts] = useState({ taskCount: 0, memoCount: 0, total: 0 });

  useEffect(() => {
    if (!vaultPath) return;

    const loadCounts = async () => {
      try {
        const memos = await memoCommands.collectCalendarMemos(vaultPath);
        const today = getTodayString();
        const todayMemos = memos.filter(m => m.date === today && !m.resolved);
        const taskCount = todayMemos.filter(m => m.isTask).length;
        const memoCount = todayMemos.filter(m => !m.isTask).length;
        setCounts({ taskCount, memoCount, total: taskCount + memoCount });
      } catch (e) {
        console.error('Failed to load memo counts:', e);
      }
    };

    loadCounts();
  }, [vaultPath, calendarRefreshTrigger]);

  return counts;
}
