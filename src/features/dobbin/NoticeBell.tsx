/**
 * 알림 벨 — **곁눈질에 필요한 것은 패널이 아니라 알림이었다** (2026-08-27)
 *
 * 사용자: *"dobbin 창에서 dobbin 패널의 기능을 모두 사용할 수 있다면
 * (채팅, 채팅 달력 등) 굳이 패널이 왜 필요하지?"*
 *
 * 🔴 **필요 없다.** 패널이 홈보다 나은 점은 «노트를 보면서 같이 보인다»
 *    하나뿐인데, 이 앱은 노트를 hover 창으로 띄운다 — 홈을 무대에 두고
 *    노트를 창으로 띄우면 같은 일이 되고 dobbin 이 280px 에 갇히지도 않는다.
 *    그래서 dobbin 을 패널에서 걷었다.
 *
 *    다만 **일하다 흘끗 보는 것**은 남는 수요다. 그건 대화가 아니라 «알림»
 *    이므로, 패널이 아니라 벨 + 팝오버로 충분하다 (읽기 전용 · 줄마다 행동
 *    하나 · 「dobbin 열기」로 무대로).
 */
import { useState } from 'react';
import { Popover } from '../../design-system/components';
import { PenguinFace } from './PenguinFace';
import { NoticeList, useNotices, unseenCount, markAllSeen } from './NoticeList';
import { uiActions } from '../../core/stores/uiStore';
import './notice.css';

export function NoticeBell({ mood }: { mood: 'idle' | 'thinking' | 'alert' }) {
  const { list } = useNotices();
  const [open, setOpen] = useState(false);
  const n = unseenCount(list);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && list.length) {
          markAllSeen(list);
          window.dispatchEvent(new CustomEvent('dobbin:notices-seen'));
        }
      }}
      placement="left-start"
      trigger={
        <button className={`right-tab${open ? ' active' : ''}`}
                title="dobbin 알림">
          <PenguinFace mood={mood} size={19} />
          {n > 0 && (
            <span className="right-tab__ask" aria-label={`${n}건 알림`}>{n}</span>
          )}
        </button>
      }
    >
      <div className="ntc__pop">
        <div className="ntc__pop-head">
          <b>dobbin</b>
          <span>이 서재를 돌보고 있습니다</span>
        </div>
        <div className="ntc__pop-body">
          <NoticeList list={list} />
        </div>
        <button className="ntc__pop-go"
                onClick={() => { setOpen(false); uiActions.setShowDobbinHome(true); }}>
          dobbin 열기
        </button>
      </div>
    </Popover>
  );
}
