/**
 * ScheduleEditor — BottomSheet for creating/editing schedule events.
 * Uses the existing BottomSheet component with form fields.
 */
import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BottomSheet } from '../BottomSheet';
export interface ScheduleEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  end_time?: string;
  repeat?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  reminder?: number;
  color: string;
  memo?: string;
}

const COLORS = [
  { name: '파랑', value: 'var(--c-blue)' },
  { name: '빨강', value: 'var(--c-red)' },
  { name: '초록', value: 'var(--c-green)' },
  { name: '주황', value: 'var(--c-orange)' },
  { name: '보라', value: 'var(--c-purple)' },
  { name: '분홍', value: 'var(--c-pink)' },
];

const REMINDER_OPTIONS = [
  { label: '없음', value: 0 },
  { label: '5분 전', value: 5 },
  { label: '15분 전', value: 15 },
  { label: '30분 전', value: 30 },
  { label: '1시간 전', value: 60 },
];

const REPEAT_OPTIONS = [
  { label: '반복 안 함', value: '' },
  { label: '매일', value: 'daily' },
  { label: '매주', value: 'weekly' },
  { label: '매월', value: 'monthly' },
  { label: '매년', value: 'yearly' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  vaultPath: string;
  date: string;         // YYYY-MM-DD (default date for new events)
  editEvent?: ScheduleEvent | null;
}

function generateId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ScheduleEditor({ open, onClose, onSaved, vaultPath, date, editEvent }: Props) {
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState(date);
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [color, setColor] = useState(COLORS[0].value);
  const [reminder, setReminder] = useState(0);
  const [repeat, setRepeat] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form when opening
  useEffect(() => {
    if (open) {
      if (editEvent) {
        setTitle(editEvent.title);
        setEventDate(editEvent.date);
        setTime(editEvent.time ?? '');
        setEndTime(editEvent.end_time ?? '');
        setColor(editEvent.color ?? COLORS[0].value);
        setReminder(editEvent.reminder ?? 0);
        setRepeat(editEvent.repeat ?? '');
        setMemo(editEvent.memo ?? '');
      } else {
        setTitle('');
        setEventDate(date);
        setTime('');
        setEndTime('');
        setColor(COLORS[0].value);
        setReminder(0);
        setRepeat('');
        setMemo('');
      }
    }
  }, [open, editEvent, date]);

  const handleSave = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);

    const event: ScheduleEvent = {
      id: editEvent?.id ?? generateId(),
      title: title.trim(),
      date: eventDate,
      time: time || undefined,
      endTime: endTime || undefined,
      repeat: (repeat as ScheduleEvent['repeat']) || undefined,
      reminder: reminder || undefined,
      color,
      memo: memo.trim() || undefined,
    };

    try {
      if (editEvent) {
        await invoke('schedule_update', { vaultPath, event });
      } else {
        await invoke('schedule_create', { vaultPath, event });
      }
      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to save schedule:', e);
    } finally {
      setSaving(false);
    }
  }, [title, eventDate, time, endTime, color, reminder, repeat, memo, editEvent, vaultPath, onSaved, onClose]);

  const handleDelete = useCallback(async () => {
    if (!editEvent) return;
    try {
      await invoke('schedule_delete', { vaultPath, eventId: editEvent.id });
      onSaved();
      onClose();
    } catch (e) {
      console.error('Failed to delete schedule:', e);
    }
  }, [editEvent, vaultPath, onSaved, onClose]);

  return (
    <BottomSheet open={open} onClose={onClose} title={editEvent ? '일정 편집' : '새 일정'}>
      <div className="schedule-editor-form">
        {/* Title */}
        <input
          className="schedule-editor-title-input"
          type="text"
          placeholder="일정 제목"
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus
        />

        {/* Date */}
        <div className="schedule-editor-row">
          <label className="schedule-editor-label">날짜</label>
          <input
            type="date"
            className="schedule-editor-input"
            value={eventDate}
            onChange={e => setEventDate(e.target.value)}
          />
        </div>

        {/* Time */}
        <div className="schedule-editor-row">
          <label className="schedule-editor-label">시작</label>
          <input
            type="time"
            className="schedule-editor-input"
            value={time}
            onChange={e => setTime(e.target.value)}
          />
        </div>

        <div className="schedule-editor-row">
          <label className="schedule-editor-label">종료</label>
          <input
            type="time"
            className="schedule-editor-input"
            value={endTime}
            onChange={e => setEndTime(e.target.value)}
          />
        </div>

        {/* Color */}
        <div className="schedule-editor-row">
          <label className="schedule-editor-label">색상</label>
          <div className="schedule-editor-colors">
            {COLORS.map(c => (
              <button
                key={c.value}
                className={`schedule-editor-color ${color === c.value ? 'active' : ''}`}
                style={{ backgroundColor: c.value }}
                onClick={() => setColor(c.value)}
                title={c.name}
              />
            ))}
          </div>
        </div>

        {/* Reminder */}
        <div className="schedule-editor-row">
          <label className="schedule-editor-label">알림</label>
          <select
            className="schedule-editor-select"
            value={reminder}
            onChange={e => setReminder(Number(e.target.value))}
          >
            {REMINDER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Repeat */}
        <div className="schedule-editor-row">
          <label className="schedule-editor-label">반복</label>
          <select
            className="schedule-editor-select"
            value={repeat}
            onChange={e => setRepeat(e.target.value)}
          >
            {REPEAT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Memo */}
        <div className="schedule-editor-row schedule-editor-row--column">
          <label className="schedule-editor-label">메모</label>
          <textarea
            className="schedule-editor-textarea"
            placeholder="메모 (선택)"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            rows={3}
          />
        </div>

        {/* Actions */}
        <div className="schedule-editor-actions">
          {editEvent && (
            <button className="schedule-editor-delete-btn" onClick={handleDelete}>
              삭제
            </button>
          )}
          <button
            className="schedule-editor-save-btn"
            onClick={handleSave}
            disabled={!title.trim() || saving}
          >
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
