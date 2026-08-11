/** 경로 — 브라우저에는 경로 개념이 없다
 *
 * web notology의 경로는 `루트:상대경로` 형식이다 (`vault:01_Tasks/…`).
 * 서버가 그걸 실제 마운트로 푼다. 여기서는 문자열만 다룬다.
 */
export async function join(...parts: string[]): Promise<string> {
  const [head, ...rest] = parts.filter(Boolean);
  if (!head) return 'vault:';
  const i = head.indexOf(':');
  const root = i > 0 ? head.slice(0, i) : 'vault';
  const first = i > 0 ? head.slice(i + 1) : head;
  const segs = [first, ...rest].filter((s) => s && s !== '.')
    .map((s) => s.replace(/^\/+|\/+$/g, ''));
  return `${root}:${segs.filter(Boolean).join('/')}`;
}
export const normalize = async (p: string) => p;
export const resolve = async (...p: string[]) => join(...p);
export const dirname = async (p: string) => p.replace(/\/[^/]*$/, '');
export const basename = async (p: string) => p.split('/').pop() ?? p;
export const sep = () => '/';
export const appDataDir = async () => 'app:';
export const appConfigDir = async () => 'app:';
