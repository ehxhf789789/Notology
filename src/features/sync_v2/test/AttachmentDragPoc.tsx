/**
 * Track B Phase B-1 POC — External drag-out capability probe (dev-only).
 *
 * Mount this component temporarily (e.g. behind a dev menu toggle or an
 * import.meta.env.DEV check). It is NOT wired into production code.
 *
 * Test plan (Phase B-1 spec §2.3):
 *   1. Click "Pick a file" → choose any local file (PDF preferred for §2.3 scenario)
 *   2. Drag the chip out of the Notology window
 *   3. Drop onto: Desktop / KakaoTalk chat input / Outlook compose / File Explorer
 *   4. Observe and report:
 *        - Did the file actually copy? Or did only a text URL get dropped?
 *        - Same result across target apps?
 *
 * Two approaches are tried per dragstart:
 *   A. HTML5 standard       — `setData('text/uri-list', file:///...)`
 *   B. Same + Tauri probe   — invoke('attachment_drag_poc_prepare') first to
 *                              validate the path and grab canonicalized form.
 *
 * Expected outcome on WebView2 (Windows): both fail to produce a real file
 * drop in target apps (only URL text drops). If so, Phase B-3 must use the
 * `tauri-plugin-drag` plugin (Approach C). This component will print which
 * approach succeeded so HanBin can confirm before Phase B-2 starts.
 */

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

interface DragPayload {
  absolute_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  same_volume_as_local: boolean;
}

interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export function AttachmentDragPoc() {
  const [picked, setPicked] = useState<DragPayload | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const appendLog = useCallback((level: LogEntry['level'], msg: string) => {
    setLog((prev) => [
      ...prev.slice(-49),
      { ts: new Date().toISOString().slice(11, 23), level, msg },
    ]);
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const result = await openDialog({
        multiple: false,
        directory: false,
        title: 'Pick a file for the drag-out POC',
      });
      if (typeof result !== 'string') {
        appendLog('warn', 'dialog cancelled');
        return;
      }
      const payload = await invoke<DragPayload>('attachment_drag_poc_prepare', {
        absolutePath: result,
      });
      setPicked(payload);
      appendLog(
        'info',
        `prepared: ${payload.file_name} (${payload.size_bytes}B, ${payload.mime_type}, sameVol=${payload.same_volume_as_local})`,
      );
    } catch (err) {
      appendLog('error', `pick failed: ${String(err)}`);
    }
  }, [appendLog]);

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!picked) return;

      const fileUrl = pathToFileUrl(picked.absolute_path);

      // Approach A — HTML5 standard
      e.dataTransfer.effectAllowed = 'copyMove';
      try {
        e.dataTransfer.setData('text/uri-list', fileUrl);
        e.dataTransfer.setData('text/plain', fileUrl);
        e.dataTransfer.setData('DownloadURL', `${picked.mime_type}:${picked.file_name}:${fileUrl}`);
        appendLog('info', `dragstart A: setData uri-list/plain/DownloadURL = ${fileUrl}`);
      } catch (err) {
        appendLog('error', `dragstart A failed: ${String(err)}`);
      }
    },
    [picked, appendLog],
  );

  const handleDragEnd = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const effect = e.dataTransfer.dropEffect;
      appendLog('info', `dragend: dropEffect=${effect}`);
    },
    [appendLog],
  );

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 99999,
        width: 360,
        maxHeight: 480,
        background: 'rgba(20, 20, 28, 0.95)',
        color: '#e6e6e6',
        border: '1px solid #444',
        borderRadius: 8,
        padding: 12,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 12 }}>Track B Drag-Out POC</div>

      <button
        type="button"
        onClick={pickFile}
        style={{
          background: '#2d4',
          color: '#000',
          border: 'none',
          borderRadius: 4,
          padding: '6px 10px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Pick a file
      </button>

      {picked && (
        <div
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          style={{
            background: '#345',
            border: '1px dashed #6af',
            borderRadius: 6,
            padding: 8,
            cursor: 'grab',
            userSelect: 'none',
          }}
          title="Drag me to the Desktop / KakaoTalk / Outlook"
        >
          <div style={{ fontWeight: 600 }}>{picked.file_name}</div>
          <div style={{ opacity: 0.7 }}>
            {picked.size_bytes}B · {picked.mime_type}
          </div>
          <div style={{ opacity: 0.5, fontSize: 10 }}>{picked.absolute_path}</div>
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 100,
          background: '#0c0c10',
          border: '1px solid #222',
          borderRadius: 4,
          padding: 6,
          overflowY: 'auto',
        }}
      >
        {log.length === 0 && <div style={{ opacity: 0.4 }}>(log will appear here)</div>}
        {log.map((entry, i) => (
          <div
            key={i}
            style={{
              color:
                entry.level === 'error'
                  ? '#f88'
                  : entry.level === 'warn'
                    ? '#fc6'
                    : '#cfd',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            [{entry.ts}] {entry.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function pathToFileUrl(absolutePath: string): string {
  let p = absolutePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

export default AttachmentDragPoc;
