/**
 * CalendarHomeView — TimeBlocks-inspired calendar with note-based memos.
 *
 * 5.0.10a (2026-05-17, HanBin) — token + i18n pass:
 *   • MEMO_COLORS hex array → Tier-3 `var(--c-memo-stripe-{1..7})` tokens
 *     (defined in themes.css, theme-aware).
 *   • Hardcoded weekday + month + UI strings → i18n keys (reuses
 *     `calWeekday*` / `calMonth*` from 5.0.7d desktop pass + new
 *     `mCal*` mobile keys).
 *   • Native aria-labels for nav buttons + Today pill route through t().
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { memoCommands } from '../../../core/services/tauriCommands';
import { ScheduleEditor, type ScheduleEvent } from '../components/ScheduleEditor';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { useLanguage } from '../../../core/stores/settingsStore';
import { t, tf } from '../../../core/utils/i18n';
import { EmptyState } from '../components/common';
import type { CalendarMemo } from '../../../core/types';

// CSS variables — themes.css defines `--c-memo-stripe-{1..7}`.
const MEMO_COLOR_VARS = [
  'var(--c-memo-stripe-1)',
  'var(--c-memo-stripe-2)',
  'var(--c-memo-stripe-3)',
  'var(--c-memo-stripe-4)',
  'var(--c-memo-stripe-5)',
  'var(--c-memo-stripe-6)',
  'var(--c-memo-stripe-7)',
] as const;

interface Props {
  onOpenNote: (notePath: string, name: string) => void;
}

function getDaysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function getFirstDayOfWeek(y: number, m: number) { return new Date(y, m, 1).getDay(); }
function fmtDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getWeeks(y: number, m: number): (number | null)[][] {
  const total = getDaysInMonth(y, m);
  const first = getFirstDayOfWeek(y, m);
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array(first).fill(null);
  for (let d = 1; d <= total; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }
  return weeks;
}

export default function CalendarHomeView({ onOpenNote }: Props) {
  const language = useLanguage();
  const today = new Date();
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState<number>(today.getDate());
  const [memos, setMemos] = useState<CalendarMemo[]>([]);
  // 일정 편집기 (2026-09-08 E-Ⅲ) — 3년째 미장착이던 ScheduleEditor 를 단다.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editEvent, setEditEvent] = useState<ScheduleEvent | null>(null);
  const [slideDir, setSlideDir] = useState<'left' | 'right' | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);

  const weeks = useMemo(() => getWeeks(year, month), [year, month]);

  // i18n labels — recomputed on language flip via dependency tracking
  // upstream (useLanguage triggers re-render). Reusing the desktop
  // `calWeekday*` / `calMonth*` keys keeps a single source of truth.
  const weekdayShort = useMemo(
    () => Array.from({ length: 7 }, (_, i) => t(`calWeekday${i}`, language)),
    [language],
  );
  const monthName = t(`calMonth${month}`, language);

  // For the schedule-row "March 5, Tuesday" composite label we need the
  // long weekday name. Korean lacks a separate "long" form (월/월요일 differ
  // by an extension), so we reconstruct: "{short}요일" in ko, native long
  // weekday name in en via Intl.
  const weekdayLong = useMemo(() => {
    if (language === 'ko') {
      return Array.from({ length: 7 }, (_, i) => `${t(`calWeekday${i}`, 'ko')}요일`);
    }
    const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i))); // 2024-01-07 was a Sunday
  }, [language]);

  const reload = useCallback(() => {
    if (!vaultPath) return;
    memoCommands.collectCalendarMemos(vaultPath)
      .then(setMemos).catch(() => setMemos([]));
  }, [vaultPath]);
  useEffect(() => { reload(); }, [year, month, reload]);

  const memosByDate = useMemo(() => {
    const map = new Map<string, CalendarMemo[]>();
    memos.forEach(m => {
      const arr = map.get(m.date) ?? [];
      arr.push(m);
      map.set(m.date, arr);
    });
    return map;
  }, [memos]);

  const selectedDate = fmtDate(year, month, selectedDay);
  const selectedMemos = memosByDate.get(selectedDate) ?? [];

  const isToday = (d: number | null) =>
    d !== null && year === today.getFullYear() && month === today.getMonth() && d === today.getDate();

  const isTodayInView = year === today.getFullYear() && month === today.getMonth();

  const prevMonth = useCallback(() => {
    setSlideDir('right');
    setTimeout(() => {
      if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
      setSelectedDay(1);
      setSlideDir(null);
    }, 50);
  }, [month]);

  const nextMonth = useCallback(() => {
    setSlideDir('left');
    setTimeout(() => {
      if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
      setSelectedDay(1);
      setSlideDir(null);
    }, 50);
  }, [month]);

  const goToday = useCallback(() => {
    setYear(today.getFullYear()); setMonth(today.getMonth()); setSelectedDay(today.getDate());
  }, []);

  // Swipe gesture
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 60) {
      if (dx > 0) prevMonth(); else nextMonth();
    }
  }, [prevMonth, nextMonth]);

  const selectedDayOfWeek = new Date(year, month, selectedDay).getDay();
  const isTodaySelected = isToday(selectedDay);
  const dateLabel = isTodaySelected
    ? tf('mCalDateLabelToday', language, { month: month + 1, day: selectedDay, weekday: weekdayLong[selectedDayOfWeek] })
    : tf('mCalDateLabel', language, { month: month + 1, day: selectedDay, weekday: weekdayLong[selectedDayOfWeek] });

  return (
    <div className="mobile-calendar-home">
      {/* Calendar header */}
      <div className="mobile-calendar-home-header">
        <div className="mobile-calendar-home-title-row">
          <button className="cal-nav-btn" onClick={prevMonth} aria-label={t('mCalPrevMonth', language)}>
            <ChevronLeft size={20} />
          </button>
          <h2 className="cal-month-title">
            {tf('mCalYearMonth', language, { year, month: monthName })}
          </h2>
          <button className="cal-nav-btn" onClick={nextMonth} aria-label={t('mCalNextMonth', language)}>
            <ChevronRight size={20} />
          </button>
          {!isTodayInView && (
            <button className="cal-today-pill" onClick={goToday}>{t('mCalToday', language)}</button>
          )}
        </div>

        {/* Weekday headers */}
        <div className="cal-weekday-row-v2">
          {weekdayShort.map((w, i) => (
            <div
              key={i}
              className={`cal-weekday-v2 ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}`}
            >{w}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div
          ref={gridRef}
          className={`cal-grid-v2 ${slideDir ? `cal-grid-v2--slide-${slideDir}` : ''}`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {weeks.map((week, wi) => (
            <div key={wi} className="cal-week-row-v2">
              {week.map((d, di) => {
                const dayMemos = d ? memosByDate.get(fmtDate(year, month, d)) : null;
                const hasMemos = dayMemos && dayMemos.length > 0;
                return (
                  <button
                    key={di}
                    className={[
                      'cal-day-cell',
                      d === null ? 'empty' : '',
                      isToday(d) ? 'today' : '',
                      d === selectedDay ? 'selected' : '',
                      di === 0 ? 'sun' : '',
                      di === 6 ? 'sat' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => d && setSelectedDay(d)}
                    disabled={!d}
                  >
                    <span className="cal-day-num-v2">{d}</span>
                    {hasMemos && (
                      <div className="cal-day-dots">
                        {dayMemos.slice(0, 3).map((_, i) => (
                          <span
                            key={i}
                            className="cal-day-dot"
                            style={{ background: MEMO_COLOR_VARS[i % MEMO_COLOR_VARS.length] }}
                          />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Selected day schedule list */}
      <div className="mobile-calendar-schedule-list">
        <div className="cal-schedule-header">
          <span className="cal-schedule-date">{dateLabel}</span>
          <span className="cal-schedule-count">
            {tf('mCalCount', language, { count: selectedMemos.length })}
          </span>
          <button
            className="cal-add-btn"
            aria-label="일정 추가"
            onClick={() => { setEditEvent(null); setEditorOpen(true); }}
          >
            <Plus size={18} />
          </button>
        </div>

        {selectedMemos.length === 0 ? (
          <EmptyState
            title={t('mCalEmpty', language)}
            description={t('mCalEmptyHint', language)}
          />
        ) : (
          <div className="cal-schedule-items">
            {selectedMemos.map((m, i) => (
              <button
                key={m.id}
                className="cal-schedule-item stagger-item"
                style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                onClick={() => {
                  if (m.kind === 'schedule') {
                    // 폰이 만든 일정 → 편집기로. CalendarMemo → ScheduleEvent.
                    setEditEvent({
                      id: m.id, title: m.content, date: m.date,
                      time: m.dueTime, endTime: m.endTime,
                      repeat: (m.repeat as ScheduleEvent['repeat']) || undefined,
                      reminder: m.reminder, color: m.color || MEMO_COLOR_VARS[0],
                      memo: m.memo,
                    });
                    setEditorOpen(true);
                  } else if (m.notePath) {
                    onOpenNote(m.notePath, m.noteTitle);
                  }
                  // notePath 없는 문서-기한 줄은 아직 갈 곳이 없다 — 조용히.
                }}
              >
                <div
                  className="cal-schedule-item-color"
                  style={{ background: m.color || MEMO_COLOR_VARS[i % MEMO_COLOR_VARS.length] }}
                />
                <div className="cal-schedule-item-body">
                  <div className="cal-schedule-item-title">
                    {m.isTask && (
                      <span className={m.resolved ? 'cal-task-resolved' : 'cal-task-pending'}>
                        {m.resolved ? '✓ ' : '☐ '}
                      </span>
                    )}
                    {m.content || m.anchorText}
                  </div>
                  <div className="cal-schedule-item-note">{m.noteTitle}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <ScheduleEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSaved={reload}
        vaultPath={vaultPath ?? ''}
        date={selectedDate}
        editEvent={editEvent}
      />
    </div>
  );
}
