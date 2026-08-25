// 보관소 고르기·만들기 — 여태 **눌러도 아무 일이 없던** 자리 (2026-08-25)
//
// 사용자: *"보관소 선택 및 생성 기능도 여전히 없다."*
//
// 🔴 **데스크톱 창 흐름의 잔재였다.** 사이드바 바닥의 「보관소」 단추는
//    `dispatchWindowEvent({ type: 'switch_vault_requested' })` 를 불렀고, 그것은
//    Tauri 가 **네이티브 창을 하나 더 띄우는** 길이다 (`state.rs`). 웹에는
//    그런 창이 없으므로 눌러도 조용히 아무 일이 없었다 — `vault:` 가 화면에
//    새어 나온 것, `asset://localhost/` 가 404 였던 것과 **같은 부류**다.
//
// 위계는 사용자가 정했다:
//     보관소 — 컨테이너 — 폴더노트 — 노트
// 그래서 이 고르개는 **보관소만** 보여 준다. 투입구는 보관소가 아니다
// (`is_vault:false` · 서버 `vaults.py` 머리말 · 1-2-2).
import { useState, useEffect, useRef, useCallback } from 'react';
import { FolderClosed, Plus, Check, X } from 'lucide-react';
import { invoke } from '../../web/core';
import { useVaultPath, fileTreeActions } from '../../core/stores/fileTreeStore';
import { rootLabel } from '../../core/utils/rootPath';

type Root = {
  key: string; label: string; writable: boolean;
  is_vault: boolean; path: string; exists: boolean;
};

export function VaultPicker() {
  const vaultPath = useVaultPath();
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<Root[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: '', label: '', path: '' });
  const [err, setErr] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await invoke<Root[]>('vault_roots', {});
      setRoots(Array.isArray(r) ? r : []);
    } catch { /* 목록이 막혀도 화면은 산다 */ }
  }, []);

  // 🔴 단추 이름도 서버 라벨로 — 열기 전(목록 비었을 때)만 예비 표를 쓴다
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  // 바깥을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false); setAdding(false); setErr('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // 🔴 **고른 것으로 갈아탄다.** 컨테이너 선택을 비우지 않으면 앞 보관소의
  //    칸을 가리킨 채로 남아 트리와 본문이 어긋난다.
  const pick = async (r: Root) => {
    setOpen(false);
    if (`${r.key}:` === vaultPath) return;
    fileTreeActions.setSelectedContainer(null);
    fileTreeActions.setVaultPath(`${r.key}:`);
    await fileTreeActions.refreshFileTree();
  };

  const create = async () => {
    setErr('');
    const { key, label, path } = form;
    if (!key.trim() || !path.trim()) { setErr('열쇠와 경로가 있어야 합니다'); return; }
    try {
      const r = await invoke<{ ok: boolean; why?: string; say?: string }>(
        'add_vault', { key: key.trim(), label: label.trim() || key.trim(),
                       path: path.trim(), writable: true });
      if (!r?.ok) { setErr(r?.why || '만들지 못했습니다'); return; }
      setAdding(false); setForm({ key: '', label: '', path: '' });
      await load();
    } catch (e) { setErr(String(e)); }
  };

  const here = roots.find(r => r.path === vaultPath)?.label
    || rootLabel(vaultPath) || '보관소';
  const vaults = roots.filter(r => r.is_vault);

  return (
    <div className="vault-picker" ref={boxRef}>
      <button className="sidebar-footer-btn vault-btn"
              onClick={() => setOpen(o => !o)} title="보관소 고르기">
        <FolderClosed size={14} strokeWidth={2} />
        <span className="sidebar-footer-btn-text">{here}</span>
      </button>
      {open && (
        <div className="vault-picker__menu">
          <div className="vault-picker__head">보관소</div>
          {vaults.map(r => (
            <button key={r.key} className="vault-picker__item"
                    onClick={() => void pick(r)}>
              {`${r.key}:` === vaultPath
                ? <Check size={13} strokeWidth={2.4} />
                : <span className="vault-picker__gap" />}
              <span className="vault-picker__name">{r.label}</span>
              {/* 🔴 읽기만 되는 곳은 그렇다고 말한다 — 눌러 놓고 못 쓰면 안 된다 */}
              {!r.writable && <span className="vault-picker__ro">읽기만</span>}
              {!r.exists && <span className="vault-picker__ro">없는 경로</span>}
            </button>
          ))}
          {!adding ? (
            <button className="vault-picker__add" onClick={() => setAdding(true)}>
              <Plus size={13} strokeWidth={2.4} /> 새 보관소
            </button>
          ) : (
            <div className="vault-picker__form">
              <input placeholder="열쇠 (예: study)" value={form.key}
                     onChange={e => setForm(f => ({ ...f, key: e.target.value }))} />
              <input placeholder="이름 (예: 연구실 공용)" value={form.label}
                     onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
              <input placeholder="경로 (예: /mnt/nas/30_study)" value={form.path}
                     onChange={e => setForm(f => ({ ...f, path: e.target.value }))} />
              {err && <div className="vault-picker__err">{err}</div>}
              <div className="vault-picker__row">
                <button className="vault-picker__ok" onClick={() => void create()}>
                  만들기
                </button>
                <button className="vault-picker__cancel"
                        onClick={() => { setAdding(false); setErr(''); }}>
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
