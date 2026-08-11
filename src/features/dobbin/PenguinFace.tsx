/**
 * dobbin의 얼굴 — 펭귄 (사용자 요청, 2026-08-11)
 *
 *   *"dobbin AI의 애니메이션 아이콘을 펭귄 아이콘으로 바꿔줘.
 *     (dobbin AI 캐릭터는 펭귄 얼굴)"*
 *
 * 앞의 얼굴은 책 위로 눈이 보이는 모양이었다. 펭귄으로 바꾸되 **상태가
 * 보인다는 규율은 그대로다** (2-14-2-2): 움직임에는 전부 뜻이 있다.
 *
 * | 상태 | 펭귄이 하는 것 |
 * |---|---|
 * | `idle` | 느린 숨 · 가끔 깜빡임 |
 * | `reading` | 고개를 좌우로 (읽는 눈짓) |
 * | `thinking` | 머리 위 점 셋 |
 * | `found` | 한 번 폴짝 |
 * | `alert` | 붉은 맥박 |
 *
 * 🔴 **그림 파일을 쓰지 않는다.** SVG 인라인이라 받아올 것이 없고, 색이
 *    테마를 따라간다.
 */

export type Mood = 'idle' | 'reading' | 'thinking' | 'found' | 'alert';

export function PenguinFace({ mood, size = 30 }: { mood: Mood; size?: number }) {
  return (
    <svg className={`peng peng--${mood}`} viewBox="0 0 40 40"
         width={size} height={size} aria-hidden="true">
      {/* 생각할 때만 뜨는 점 셋 */}
      <g className="peng-dots">
        <circle cx="13" cy="4" r="1.6" /><circle cx="20" cy="2.6" r="1.6" />
        <circle cx="27" cy="4" r="1.6" />
      </g>

      <g className="peng-head">
        {/* 머리 — 검은 몸 */}
        <ellipse className="peng-body" cx="20" cy="21" rx="13" ry="13.5" />
        {/* 얼굴 — 흰 배. 펭귄의 특징은 이 하얀 하트꼴이다 */}
        <path className="peng-belly"
              d="M20 11.5c6 0 9 4.4 9 9.4 0 5.2-4 8.6-9 8.6s-9-3.4-9-8.6c0-5 3-9.4 9-9.4z" />
        {/* 눈 */}
        <circle className="peng-eye peng-eye--l" cx="15.6" cy="19.4" r="2.3" />
        <circle className="peng-eye peng-eye--r" cx="24.4" cy="19.4" r="2.3" />
        <circle className="peng-pupil" cx="16.1" cy="19.7" r="1.05" />
        <circle className="peng-pupil" cx="24.9" cy="19.7" r="1.05" />
        {/* 부리 */}
        <path className="peng-beak" d="M20 22.6l3.1 2.5-3.1 2.2-3.1-2.2z" />
      </g>

      {/* 지느러미 — 찾았을 때 한 번 든다 */}
      <ellipse className="peng-wing peng-wing--l" cx="6.6" cy="23" rx="3.1" ry="6.6" />
      <ellipse className="peng-wing peng-wing--r" cx="33.4" cy="23" rx="3.1" ry="6.6" />
    </svg>
  );
}
