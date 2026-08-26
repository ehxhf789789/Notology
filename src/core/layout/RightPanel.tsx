import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  PanelRightClose,
  CheckSquare,
  MessageCircle,
  Search as SearchIcon,
} from 'lucide-react';
import { memoCommands } from '../services/tauriCommands';
import { useVaultPath } from '../stores/fileTreeStore';
import { refreshActions } from '../stores/refreshStore';
import { hoverActions } from '../../features/hover-windows/stores/hoverStore';
import { useCalendarRefreshTrigger } from '../stores/refreshStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useRightTab, useDobbinView, rightActions } from '../stores/rightTabStore';
import { IntakePanel } from '../../features/dobbin/IntakePanel';
import { DobbinSurface } from '../../features/dobbin/DobbinSurface';
import { t, tf } from '../utils/i18n';
import { loadComments, saveComments } from '../../features/comments/comments';
import { notifyMemoChanged } from '../utils/windowSync';
import type { CalendarMemo, CalendarViewMode, CalendarLayoutMode } from '../types';
import { IconButton, SegmentedControl, Popover } from '../../design-system/components';

/* ============================================================
   Stage 5.0.3a-rework (2026-05-15)
   ------------------------------------------------------------
   5.0.3a originally introduced a 5-tab layout (Calendar / Tags /
   Comments / Outline / Metadata) here. HanBin's smoke test
   showed the 4 per-note tabs were structurally empty in the main
   window context — per-note panels live inside hover windows
   (TagPanel + CommentPanel in HoverEditor.tsx). The tab-row was
   a design mistake.

   This file is now back to a single surface — the vault-wide
   calendar / task aggregate, same shape as pre-5.0.3a but with
   the 5.0.3a improvements (extracted calendar logic) preserved.

   Per-note panels stay where they were before 5.0.3a:
     Tags / Comments → hover window header icon buttons (existing)
     Outline         → planned for 5.0.4b in hover window header
     Metadata        → TagPanel's existing yaml mode (no separate UI)
   ============================================================ */

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
  const tab = useRightTab();
  const view = useDobbinView();

  return (
    <div className="right-panel" style={{ width }}>
      <header className="right-panel-header">
        <div className="right-panel-header-left">
          {tab === 'calendar' ? (
            <>
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
            </>
          ) : (
            <div className="right-panel-today-info">
              <span className="right-panel-today-label">
                {tab === 'dobbin' ? 'dobbin' : '자료 넣기'}
              </span>
              <span className="right-panel-today-date">
                {/* 🔴 「사서에게 묻기」가 아니다 (A54 · 2026-08-27). 상주
                    관리자를 「물어보는 도구」로 적으면 자리와 말이 같이
                    틀린다 — dobbin 은 늘 여기서 서재를 돌보고 있다. */}
                {tab === 'dobbin' ? '이 서재를 돌보고 있습니다' : '읽고 정리합니다'}
              </span>
            </div>
          )}
        </div>
        {/* 🔴 **머리글은 하나다.** dobbin 화면이 자기 머리를 또 그려서
            접기 단추와 겹쳐 있었다 (사용자 지적, 2026-08-12).
            달력·검색은 여기, 공용 머리의 오른쪽에 나란히 선다. */}
        <div className="right-panel-header-actions">
          {tab === 'dobbin' && (
            <>
              <IconButton
                icon={<CalendarDays size={16} />}
                aria-label="날짜로 찾기"
                variant={view === 'cal' ? 'soft' : 'ghost'}
                size="sm"
                onClick={() => rightActions.view('cal')}
              />
              <IconButton
                icon={<SearchIcon size={16} />}
                aria-label="대화 검색"
                variant={view === 'search' ? 'soft' : 'ghost'}
                size="sm"
                onClick={() => rightActions.view('search')}
              />
            </>
          )}
          <IconButton
            icon={<PanelRightClose size={18} />}
            aria-label={t('close', language)}
            variant="ghost"
            size="sm"
            onClick={() => setShowHoverPanel(false)}
          />
        </div>
      </header>

      {/* 🔴 탭이 정한 것만 보여준다 — 서류철처럼 하나만 앞에 온다 */}
      {tab === 'calendar' && <CalendarSurface />}
      {tab === 'dobbin' && <DobbinSurface />}
      {tab === 'intake' && <IntakePanel />}
    </div>
  );
});

export default RightPanel;

/* ============================================================
   CalendarSurface — vault-wide aggregate calendar + memo list.
   Lifted from pre-5.0.3a RightPanel; 5.0.3a-rework restores it
   as the single surface.
   ============================================================ */
/* 2026-05-26 (HanBin) — 5.0.7d-followup landing.
   Adds Month/Day layout toggle, chip stripe on day cells, and a click-
   to-Popover preview. Existing month grid + memo list flow is preserved
   (HanBin sign-off "공존" — Popover와 list 둘 다 유지). Day view is a
   24-hour timeline of the selected date driven by the new
   `dueTime` field on CalendarMemo (Rust side maps task.dueTime). */

const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface ChipBucket { taskCount: number; memoCount: number; total: number; }

function CalendarSurface() {
  const vaultPath = useVaultPath();
  const calendarRefreshTrigger = useCalendarRefreshTrigger();
  const language = useSettingsStore(s => s.language);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(getTodayString());
  const [memos, setMemos] = useState<CalendarMemo[]>([]);
  const [viewMode, setViewMode] = useState<CalendarViewMode>('task');
  // 2026-05-26 (HanBin) — month grid vs single-day 24-hour timeline.
  const [layoutMode, setLayoutMode] = useState<CalendarLayoutMode>('month');
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

  // 2026-05-26 — per-date task/memo counts for chip-stripe rendering.
  // Uses the unfiltered memo set so chips reflect totals regardless of
  // viewMode (so the stripe doesn't disappear when toggling task/memo).
  const chipsByDate = useMemo(() => {
    const g = new Map<string, ChipBucket>();
    for (const m of memos) {
      if (m.resolved && !temporarilyResolved.has(m.id)) continue;
      const bucket = g.get(m.date) ?? { taskCount: 0, memoCount: 0, total: 0 };
      if (m.isTask) bucket.taskCount += 1;
      else bucket.memoCount += 1;
      bucket.total += 1;
      g.set(m.date, bucket);
    }
    return g;
  }, [memos, temporarilyResolved]);

  const selectedDateMemos = useMemo(() => memosByDate.get(selectedDate) || [], [selectedDate, memosByDate]);

  /** Day-view timeline grouping: separates time-less memos from
   *  hour-bucketed tasks. `noTime` lists items without `dueTime`;
   *  `byHour` keys are 0..23. */
  const timelineForSelected = useMemo(() => {
    const items = selectedDateMemos;
    const noTime: CalendarMemo[] = [];
    const byHour = new Map<number, CalendarMemo[]>();
    for (const m of items) {
      const t = m.dueTime;
      const hour = t && /^\d{1,2}:/.test(t) ? Math.min(23, Math.max(0, parseInt(t, 10))) : null;
      if (hour === null) noTime.push(m);
      else byHour.set(hour, [...(byHour.get(hour) ?? []), m]);
    }
    return { noTime, byHour };
  }, [selectedDateMemos]);

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

  /** prev/next navigation — month-step in month layout, day-step in day. */
  const changePeriod = (delta: number) => {
    if (layoutMode === 'month') {
      setCurrentDate(prev => {
        const d = new Date(prev);
        d.setMonth(d.getMonth() + delta);
        return d;
      });
    } else {
      const base = new Date(selectedDate);
      base.setDate(base.getDate() + delta);
      const newStr = formatDate(base);
      setSelectedDate(newStr);
      // Keep month header in sync when crossing month boundaries.
      if (base.getMonth() !== currentDate.getMonth() || base.getFullYear() !== currentDate.getFullYear()) {
        setCurrentDate(base);
      }
    }
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

  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Header label — month name + year in month layout, full date in day. */
  const headerLabel = layoutMode === 'month'
    ? `${monthNames[currentDate.getMonth()]} ${currentDate.getFullYear()}`
    : new Date(selectedDate).toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', {
        month: 'short', day: 'numeric', weekday: 'short',
      });

  /** Per-cell Popover content: that date's memos as a compact preview.
   *  Items share the same click/resolve UX as the main list below. */
  const renderDayPopover = (dateStr: string) => {
    const items = memosByDate.get(dateStr) || [];
    if (items.length === 0) {
      return (
        <div className="right-panel-day-popover__empty">
          {viewMode === 'task' ? t('calendarNoTasks', language) : t('calendarNoMemos', language)}
        </div>
      );
    }
    return (
      <div className="right-panel-day-popover__list">
        {items.map(memo => (
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
              <div className="right-panel-memo-meta">
                {memo.dueTime ? `${memo.dueTime} · ` : ''}{memo.noteTitle}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      {/* 2026-05-26 (HanBin) — `.is-day-layout` lets CSS flex the calendar
          container to fill remaining height so the 24-hour timeline can
          scroll internally instead of pushing past the panel's bottom
          (HanBin: 일로 변환할 경우 아래가 잘림). Month layout keeps the
          old `flex: 0 0 auto` so the memo list below has its share. */}
      <div className={`right-panel-calendar${layoutMode === 'day' ? ' is-day-layout' : ''}`}>
        <div className="right-panel-calendar-nav">
          <button onClick={() => changePeriod(-1)} className="right-panel-nav-btn" aria-label={t('prevMonth', language)}>
            <ChevronLeft size={14} />
          </button>
          <span className="right-panel-month">{headerLabel}</span>
          <button onClick={() => changePeriod(1)} className="right-panel-nav-btn" aria-label={t('nextMonth', language)}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="right-panel-calendar-layout-toggle">
          <SegmentedControl
            size="sm"
            value={layoutMode}
            onChange={(v) => setLayoutMode(v as CalendarLayoutMode)}
            options={[
              { value: 'month', label: t('calendarMonthView', language) },
              { value: 'day', label: t('calendarDayView', language) },
            ]}
            ariaLabel={t('calendarLayoutMode', language)}
          />
        </div>

        {layoutMode === 'month' && (
          <div className="right-panel-calendar-grid">
            <div className="right-panel-weekdays">
              {dayNames.map((d, i) => <div key={i} className="right-panel-weekday">{d}</div>)}
            </div>
            <div className="right-panel-days">
              {calendarGrid.map((day, idx) => {
                if (day === null) return <div key={idx} className="right-panel-day empty" />;
                const dateStr = formatDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), day));
                const chips = chipsByDate.get(dateStr);
                const selected = dateStr === selectedDate;
                const isTd = isToday(day);
                const cellEl = (
                  <div
                    className={`right-panel-day${isTd ? ' today' : ''}${selected ? ' selected' : ''}${chips && chips.total > 0 ? ' has-memos' : ''}`}
                    onClick={() => handleDateClick(day)}
                  >
                    <span className="right-panel-day-number">{day}</span>
                    {chips && chips.total > 0 && (
                      <div className="right-panel-day-chips">
                        {Array.from({ length: Math.min(chips.taskCount, 2) }).map((_, i) => (
                          <span key={`t${i}`} className="right-panel-day-chip is-task" />
                        ))}
                        {Array.from({ length: Math.min(chips.memoCount, 2) }).map((_, i) => (
                          <span key={`m${i}`} className="right-panel-day-chip is-memo" />
                        ))}
                        {chips.total > 4 && (
                          <span className="right-panel-day-chip-more">
                            {tf('calendarMore', language, { count: chips.total - 4 })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
                return (
                  <Popover
                    key={idx}
                    placement="bottom"
                    trigger={cellEl}
                  >
                    <div className="right-panel-day-popover">
                      <div className="right-panel-day-popover__header">
                        {new Date(dateStr).toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', {
                          month: 'short', day: 'numeric', weekday: 'short',
                        })}
                      </div>
                      {renderDayPopover(dateStr)}
                    </div>
                  </Popover>
                );
              })}
            </div>
          </div>
        )}

        {layoutMode === 'day' && (
          <div className="right-panel-day-timeline">
            {timelineForSelected.noTime.length > 0 && (
              <div className="right-panel-day-timeline__no-time">
                <div className="right-panel-day-timeline__label">
                  {t('calendarNoTimeSlot', language)} ({timelineForSelected.noTime.length})
                </div>
                {timelineForSelected.noTime.map(memo => (
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
              </div>
            )}
            <div className="right-panel-day-timeline__hours">
              {HOURS.map(hour => {
                const items = timelineForSelected.byHour.get(hour) ?? [];
                return (
                  <div key={hour} className={`right-panel-day-timeline__row${items.length === 0 ? ' is-empty' : ''}`}>
                    <div className="right-panel-day-timeline__hour-label">
                      {tf('calendarHour', language, { hour: String(hour).padStart(2, '0') })}
                    </div>
                    <div className="right-panel-day-timeline__hour-items">
                      {items.map(memo => (
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
                            <div className="right-panel-memo-meta">
                              {memo.dueTime ? `${memo.dueTime} · ` : ''}{memo.noteTitle}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 2026-05-26 (HanBin) — bottom memo list lives only in month
          layout. In day layout the 24-hour timeline above already shows
          the selected date's full content, so rendering the list below
          duplicates it AND consumes vertical space that the timeline
          needs to scroll 0-23 hours within the panel (HanBin: 일로
          변환할 경우 아래가 잘림 fix). */}
      {layoutMode === 'month' && (<>
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
                <div className="right-panel-memo-meta">
                  {memo.dueTime ? `${memo.dueTime} · ` : ''}{memo.noteTitle}
                </div>
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
      </>)}
    </>
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
