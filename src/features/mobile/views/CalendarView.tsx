/**
 * CalendarView — Mobile monthly calendar grid.
 * Portrait: full-width calendar with schedule below.
 * Landscape: calendar left, schedule right (split view).
 */
import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useResponsiveLayout } from '../../../hooks/useResponsiveLayout';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export default function CalendarView() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(today.getDate());
  const navMode = useResponsiveLayout();
  const isLandscape = navMode === 'bottom-tab-compact' || navMode === 'sidebar';

  const days = useMemo(() => {
    const total = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfWeek(year, month);
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    return cells;
  }, [year, month]);

  const isToday = (d: number | null) =>
    d !== null && year === today.getFullYear() && month === today.getMonth() && d === today.getDate();

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const goToToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setSelectedDay(today.getDate());
  };

  const calendarContent = (
    <div className="mobile-calendar-panel">
      <div className="mobile-calendar-header">
        <button className="mobile-calendar-nav" onClick={prevMonth}>
          <ChevronLeft size={22} />
        </button>
        <span className="mobile-calendar-month">{year}년 {month + 1}월</span>
        <button className="mobile-calendar-nav" onClick={nextMonth}>
          <ChevronRight size={22} />
        </button>
        <button className="mobile-calendar-today-btn" onClick={goToToday}>오늘</button>
      </div>
      <div className="mobile-calendar-weekdays">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`mobile-calendar-weekday ${i === 0 ? 'sunday' : i === 6 ? 'saturday' : ''}`}>{w}</div>
        ))}
      </div>
      <div className="mobile-calendar-grid">
        {days.map((d, i) => (
          <div
            key={i}
            className={`mobile-calendar-day ${d === null ? 'empty' : ''} ${isToday(d) ? 'today' : ''} ${d === selectedDay ? 'selected' : ''} ${i % 7 === 0 ? 'sunday' : i % 7 === 6 ? 'saturday' : ''}`}
            onClick={() => d !== null && setSelectedDay(d)}
          >
            {d}
          </div>
        ))}
      </div>
    </div>
  );

  const scheduleContent = (
    <div className="mobile-calendar-schedule">
      <div className="mobile-calendar-schedule-header">
        {selectedDay ? `${month + 1}월 ${selectedDay}일` : '날짜를 선택하세요'}
      </div>
      <div className="mobile-calendar-schedule-empty">
        일정이 없습니다
      </div>
    </div>
  );

  return (
    <div className={`mobile-container-list ${isLandscape ? 'mobile-calendar-landscape' : ''}`}>
      {calendarContent}
      {scheduleContent}
    </div>
  );
}
