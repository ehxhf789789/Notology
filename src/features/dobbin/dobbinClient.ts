/** dobbin — 이 서재를 관리하는 사서에게 말을 건다
 *
 * **AI는 dobbin, 웹은 notology다.** dobbin이 판단하고 notology가 보여준다.
 * 이 파일이 둘 사이의 유일한 통로다.
 *
 * 🔴 **notology가 분류하지 않는다.** 여기서 하는 일은 묻고 받아 적는 것뿐이다.
 *    검색·분류·좌표는 전부 서버가 안다 (CLAUDE.md 2-4: LLM은 경로를 만들지 않는다).
 */

export interface DobbinMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

/** 답변에 섞인 좌표 — `T01-정보통신-2512-0007` 꼴. 클릭해서 갈 수 있게 뽑는다. */
export const LOCATION_CODE = /\b([A-Z]\d{2}-[^\s|]{1,20}-\d{4}-\d{4})\b/g;

/** 답변에 섞인 보관함 경로 — 표에 `01_Tasks/…/attachments/파일.pdf` 로 온다.
 *
 * 🔴 **공백을 허용해야 한다.** 폴더 이름에 공백이 있다:
 *      01_Tasks/본부 기획 과제/attachments/(본부기획과제)_….hwp
 *    `[^\s|]+` 로 잡으면 `01_Tasks/본부` 에서 끊겨 아무것도 안 걸린다 (실측).
 *    표 구분자 `|` 와 줄바꿈에서만 멈춘다.
 */
export const VAULT_PATH = /((?:0\d|1[0-2])_[^|\n]*?\.[A-Za-z0-9]{2,5})(?=\s|$|\|)/g;

export async function askDobbin(
  messages: DobbinMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const r = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'dobbin',
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
    signal,
  });
  if (r.status === 403) throw new Error('이 기기는 아직 승인되지 않았습니다');
  if (!r.ok) throw new Error(`dobbin이 답하지 못했습니다 (${r.status})`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? '(답이 비어 있습니다)';
}
