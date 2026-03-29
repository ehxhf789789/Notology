import { useState, useEffect } from 'react';
import { noteLockCommands } from '../../core/services/tauriCommands';
import type { NoteLockInfo } from '../../core/services/tauriCommands';

export interface UseNoteLockParams {
  filePath: string;
  vaultPath: string | null;
  windowType: 'editor' | 'pdf' | 'image' | 'code' | 'web' | 'document';
}

export function useNoteLock({ filePath, vaultPath, windowType }: UseNoteLockParams) {
  // Note-level editing lock from another device
  const [remoteLock, setRemoteLock] = useState<NoteLockInfo | null>(null);

  // Note-level editing lock: acquire + heartbeat + remote check (consolidated)
  useEffect(() => {
    if (!filePath || !vaultPath) return;

    // Acquire lock (editor type only) + heartbeat every 30s
    const isEditor = windowType === 'editor';
    if (isEditor) {
      noteLockCommands.acquireNoteLock(vaultPath, filePath).catch(() => {});
    }
    const heartbeatInterval = isEditor ? setInterval(() => {
      noteLockCommands.updateHeartbeat(vaultPath, filePath).catch(() => {});
    }, 30000) : null;

    // Check for remote locks every 10s
    const checkLock = () => {
      noteLockCommands.checkNoteLock(vaultPath, filePath)
        .then(setRemoteLock)
        .catch(() => {});
    };
    checkLock();
    const lockCheckInterval = setInterval(checkLock, 10000);

    return () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      clearInterval(lockCheckInterval);
      if (isEditor) {
        noteLockCommands.releaseNoteLock(vaultPath, filePath).catch(() => {});
      }
    };
  }, [filePath, vaultPath, windowType]);

  return { remoteLock };
}
