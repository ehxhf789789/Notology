/** 설정 — 🔴 브라우저가 아니라 **서버**에 둔다
 *
 * `localStorage`에 두면 기기마다 설정이 갈린다. **어느 기기로 들어와도 같은
 * 것을 본다**가 웹으로 옮기는 이유의 절반이다.
 */
import { invoke } from './core';

export class Store {
  constructor(private rid: number) {}
  static async load(path: string, _opt?: unknown): Promise<Store> {
    return new Store(await invoke<number>('plugin:store|load', { path }));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const [v, exists] = await invoke<[T, boolean]>('plugin:store|get', { rid: this.rid, key });
    return exists ? v : undefined;
  }
  async set(key: string, value: unknown) { await invoke('plugin:store|set', { rid: this.rid, key, value }); }
  async has(key: string) { return invoke<boolean>('plugin:store|has', { rid: this.rid, key }); }
  async keys() { return invoke<string[]>('plugin:store|keys', { rid: this.rid }); }
  async entries<T>() { return invoke<[string, T][]>('plugin:store|entries', { rid: this.rid }); }
  async delete(key: string) { await invoke('plugin:store|delete', { rid: this.rid, key }); return true; }
  async save() {}
  async close() {}
}
export const load = (path: string, opt?: unknown) => Store.load(path, opt);
export const getStore = async (path: string) => Store.load(path);
