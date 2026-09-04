/**
 * `markdownShape` 채점기 — `node src/core/utils/markdownShape.check.mjs`
 *
 * 🔴 **이 자가 없으면 다음 사람이 이 규칙을 조용히 되돌린다.** 규칙을 넓히면
 *    (예: `_` 를 강조로 다시 보면) 배너는 사라지는데 **진짜 외부 변경도 삼킨다** —
 *    딴 기기가 고친 글을 덮어쓰게 된다. 그래서 양쪽을 함께 잰다:
 *      ⓐ 꾸밈만 다른 것은 «같다»     (배너가 안 떠야 한다)
 *      ⓑ 🔴 글이 바뀐 것은 «다르다»  (배너가 여전히 떠야 한다)
 *    하나만 참이면 고친 것이 아니다.
 *
 * 그물이 필요 없다 — 저장소 안의 esbuild 로 `.ts` 를 그 자리에서 옮긴다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = transformSync(readFileSync(join(here, 'markdownShape.ts'), 'utf8'),
                          { loader: 'ts', format: 'esm' }).code;
const { markdownShape, looksSame } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let ok = 0, bad = 0;
const t = (say, got, extra) => got ? (ok++, console.log(`  ✅ ${say}`))
                                   : (bad++, console.log(`  🔴 ${say}   ${extra ?? ''}`));

// ── ⓐ 꾸밈만 다르다 → 같다 ────────────────────────────────────────────
const CHIP = "<span style='color:#6f9e7a;background:#6f9e7a22;font-weight:600'>종류</span>";
t("색 칩 vs 굵게",        looksSame(`- ${CHIP} 세미나 자료`, "- **종류** 세미나 자료"));
t("밑줄 이스케이프",      looksSame("key/시설물_상태_기록", "key/시설물\\_상태\\_기록"));
t("번호 이스케이프",      looksSame("## 1. 개요", "## 1\\. 개요"));
t("탭 vs 공백",          looksSame("\t- [[a.pdf]]", "  - [[a.pdf]]"));
t("줄 끝 공백",          looksSame("심화됨. ", "심화됨."));

// ── ⓐ' `<br>` 은 **지우면 안 된다** — 앱이 하드브레이크로 되쓴다 (서가 2장) ──
t("<br> vs 줄바꿈",       looksSame("가<br>나", "가\n나"));
t("<br> vs 백슬래시",      looksSame("가<br>나", "가\\\n나"));
t("<br> vs 공백 둘",       looksSame("가<br>나", "가  \n나"));

// ── ⓑ 🔴 진짜 변경이면 다르다 ────────────────────────────────────────
console.log("  ── 🔴 음성 대조 ──");
t("문장이 늘면",         !looksSame("- 가\n- 나", "- 가\n- 나\n- 다"));
t("낱말이 바뀌면",       !looksSame("- 세미나 자료", "- 학술 자료"));
t("링크가 바뀌면",       !looksSame("[[a.pdf]]", "[[b.pdf]]"));
t("숫자가 바뀌면",       !looksSame("2026-08-28", "2026-08-29"));
t("글이 지워지면",       !looksSame("- 가\n- 나", ""));

// ── ⓒ 🔴 밑줄·경로를 먹지 않는다 (넓게 잡았다가 실제로 먹었다, 2026-09-04) ──
console.log("  ── 🔴 낱말 안의 밑줄을 강조로 읽지 않는다 ──");
t("경로가 온전하다",     markdownShape("- 자리 `02_Projects/변환 한계`").includes("02_Projects"),
                        JSON.stringify(markdownShape("- 자리 `02_Projects/변환 한계`")));
t("태그가 온전하다",     markdownShape("key/시설물_상태_기록 · key/변환_한계") === "key/시설물_상태_기록 · key/변환_한계");
t("줄을 넘지 않는다",    markdownShape("첫 줄 _하나\n- **종류** 세미나\n둘째 _줄").includes("종류 세미나"),
                        JSON.stringify(markdownShape("첫 줄 _하나\n- **종류** 세미나\n둘째 _줄")));

// ── ⓓ 진짜 노트로 (있을 때만 — 없으면 «건너뜀» 이라 말한다) ──────────────
const NOTE = '/mnt/nas/10_library/02_Projects/변환 한계의 온톨로지 기반 지식화/'
           + 'SEM-260828-변환 한계의 온톨로지 기반 지식화.md';
if (existsSync(NOTE)) {
  const body = p => { const x = readFileSync(p, 'utf8'); const i = x.indexOf('\n---', 3);
                      return x.startsWith('---') && i > 0 ? x.slice(i + 4) : x; };
  const disk = body(NOTE);
  // 앱이 저장할 꼴을 흉내낸다 — 색 칩을 굵게로, 밑줄을 이스케이프로
  const app = disk.replace(/<span[^>]*>([^<]*)<\/span>/g, '**$1**')
                  .replace(/([가-힣A-Za-z0-9])_([가-힣A-Za-z0-9])/g, '$1\\_$2')
                  .replace(/^(#+ \d+)\./gm, '$1\\.');
  console.log("  ── 🔴 진짜 노트로 ──");
  t("① 앱이 되돌려 쓴 판 → 같다 (배너 안 뜸)", looksSame(disk, app));
  const mut = (say, f) => {                      // 🔴 헛시험 방지
    const m = f(disk);
    if (m === disk) return t(`${say}  ← 🔴 헛시험(원본이 안 바뀜)`, false);
    t(say, !looksSame(m, app));
  };
  mut("② 한 줄을 더하면 다르다",  s => s + "\n- 추가로 결정된 사항이 있다.");
  mut("③ 낱말을 고치면 다르다",   s => s.replace('세미나 자료', '학술 자료'));
  mut("④ 태그를 지우면 다르다",   s => s.replace(' · key/온톨로지', ''));
  mut("⑤ 날짜가 바뀌면 다르다",   s => s.replace('2026-08-28', '2026-08-29'));
  mut("⑥ 제목이 바뀌면 다르다",   s => s.replace('# 변환 한계의', '# 변형 한계의'));
} else {
  console.log(`  ⚠️  진짜 노트 갈래는 건너뜀 — 서가가 안 붙었다 (${NOTE})`);
}

console.log(`\n  ═══ ${ok}/${ok + bad} ═══`);
process.exit(bad ? 1 : 0);
