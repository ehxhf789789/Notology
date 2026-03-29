import { useState, useEffect, useMemo, useCallback } from 'react';
import { memoCommands } from '../../core/services/tauriCommands';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { useCalendarRefreshTrigger } from '../../core/stores/refreshStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';
import type { CalendarMemo, CalendarViewMode } from '../../core/types';

function Calendar() {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const language = useSettingsStore(s => s.language);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [memos, setMemos] = useState<CalendarMemo[]>([]);
  const [viewMode, setViewMode] = useState<CalendarViewMode>('task');
  const [temporarilyResolved, setTemporarilyResolved] = useState<Set<string>>(new Set());

  // Load memos when vault changes or calendar refresh trigger changes
  useEffect(() => {
    if (vaultPath) {
      loadMemos();
      // Select today by default (only on first load)
      if (!selectedDate) {
        const today = new Date();
        setSelectedDate(formatDate(today));
      }
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

  const formatDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Filter memos by view mode and resolved status
  const filteredMemos = useMemo(() => {
    return memos.filter(memo => {
      // Filter by view mode
      if (viewMode === 'task' && !memo.isTask) return false;
      if (viewMode === 'memo' && memo.isTask) return false;

      // Filter out resolved memos unless temporarily resolved
      if (memo.resolved && !temporarilyResolved.has(memo.id)) {
        return false;
      }

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
    if (!selectedDate) return [];
    return memosByDate.get(selectedDate) || [];
  }, [selectedDate, memosByDate]);

  // Calendar grid calculation
  const calendarGrid = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const firstDayOfWeek = firstDay.getDay(); // 0 = Sunday
    const daysInMonth = lastDay.getDate();

    const grid: (number | null)[] = [];

    // Add empty cells for days before month starts
    for (let i = 0; i < firstDayOfWeek; i++) {
      grid.push(null);
    }

    // Add days of month
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

  const handleMemoDoubleClick = (memo: CalendarMemo) => {
    hoverActions.open(memo.notePath);
  };

  const handleResolveToggle = async (memoId: string) => {
    // Add to temporarily resolved set
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

  const hasMemosOnDate = (day: number): boolean => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const date = new Date(year, month, day);
    const dateStr = formatDate(date);
    return memosByDate.has(dateStr);
  };

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const getMemoCountForDate = (day: number): number => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const date = new Date(year, month, day);
    const dateStr = formatDate(date);
    return memosByDate.get(dateStr)?.length || 0;
  };

  const getMemosForDate = (day: number): CalendarMemo[] => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const date = new Date(year, month, day);
    const dateStr = formatDate(date);
    return memosByDate.get(dateStr) || [];
  };

  return (
    <div className="calendar-view">
      {/* Header with toggle */}
      <div className="calendar-header">
        <div className="calendar-nav">
          <button onClick={() => changeMonth(-1)} className="calendar-nav-btn">‹</button>
          <span className="calendar-month-year">
            {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
          </span>
          <button onClick={() => changeMonth(1)} className="calendar-nav-btn">›</button>
        </div>
        <div className="calendar-toggle">
          <button
            className={`calendar-toggle-btn ${viewMode === 'task' ? 'active' : ''}`}
            onClick={() => setViewMode('task')}
          >
            {t('calendarTask', language)}
          </button>
          <button
            className={`calendar-toggle-btn ${viewMode === 'memo' ? 'active' : ''}`}
            onClick={() => setViewMode('memo')}
          >
            {t('calendarMemo', language)}
          </button>
        </div>
      </div>

      {/* Main content: calendar grid left, memo list right */}
      <div className="calendar-content">
        {/* Calendar grid */}
        <div className="calendar-grid-container">
          <div className="calendar-weekdays">
            {dayNames.map(day => (
              <div key={day} className="calendar-weekday">{day}</div>
            ))}
          </div>
          <div className="calendar-days">
            {calendarGrid.map((day, index) => {
              const memoCount = day !== null ? getMemoCountForDate(day) : 0;
              const dayMemos = day !== null ? getMemosForDate(day) : [];
              return (
                <div
                  key={index}
                  className={`calendar-day ${day === null ? 'empty' : ''} ${day && isToday(day) ? 'today' : ''} ${day && hasMemosOnDate(day) ? 'has-memos' : ''} ${day && formatDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), day)) === selectedDate ? 'selected' : ''}`}
                  onClick={() => day !== null && handleDateClick(day)}
                >
                  {day !== null && (
                    <>
                      <div className="calendar-day-header">
                        <span className="calendar-day-number">{day}</span>
                        {memoCount > 0 && (
                          <span className="calendar-day-badge">{memoCount}</span>
                        )}
                      </div>
                      <div className="calendar-day-memos">
                        {dayMemos.map(memo => (
                          <div
                            key={memo.id}
                            className={`calendar-day-memo-chip ${memo.isTask ? 'task' : 'memo'} ${memo.resolved ? 'resolved' : ''}`}
                            title={memo.content}
                          >
                            {memo.content}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Memo list for selected date */}
        <div className="calendar-memo-list">
          <div className="calendar-memo-list-header">
            {selectedDate && (
              <span>{new Date(selectedDate).toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}</span>
            )}
            <span className="calendar-memo-count">{tf('calendarMemoCount', language, { count: selectedDateMemos.length })}</span>
          </div>
          <div className="calendar-memo-items">
            {selectedDateMemos.map(memo => (
              <div
                key={memo.id}
                className={`calendar-memo-item ${temporarilyResolved.has(memo.id) ? 'resolved' : ''}`}
                onDoubleClick={() => handleMemoDoubleClick(memo)}
              >
                <input
                  type="checkbox"
                  checked={temporarilyResolved.has(memo.id) || memo.resolved}
                  onChange={() => handleResolveToggle(memo.id)}
                  className="calendar-memo-checkbox"
                />
                <div className="calendar-memo-content">
                  <div className="calendar-memo-text">{memo.content}</div>
                  <div className="calendar-memo-meta">
                    <span className="calendar-memo-note">{memo.noteTitle}</span>
                    {memo.anchorText && (
                      <span className="calendar-memo-anchor"> · {memo.anchorText}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {selectedDateMemos.length === 0 && selectedDate && (
              <div className="calendar-memo-empty">
                {viewMode === 'task' ? t('calendarNoTasks', language) : t('calendarNoMemos', language)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Calendar;
