// Tauri command wrappers for sync_v2 backend.

import { invoke } from '@tauri-apps/api/core';
import type { SyncReport, SyncState, NoteWithConflicts } from '../../core/types/sync';

export type SyncV2Config = {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  remoteBase: string;
};

export const syncV2Commands = {
  syncNow: () =>
    invoke<SyncReport>('sync_v2_now'),

  getState: () =>
    invoke<SyncState>('sync_v2_get_state'),

  listConflicts: () =>
    invoke<NoteWithConflicts[]>('sync_v2_list_conflicts'),

  resolveConflict: (noteId: string, branchId: string) =>
    invoke<void>('sync_v2_resolve_conflict', { noteId, branchId }),

  getBranchContent: (noteId: string, branchId: string) =>
    invoke<string>('sync_v2_get_branch_content', { noteId, branchId }),

  // Config commands (4.10)
  getConfig: () =>
    invoke<SyncV2Config>('sync_v2_get_config'),

  saveConfig: (config: SyncV2Config) =>
    invoke<void>('sync_v2_save_config', { config }),

  testConnection: (url: string, username: string, password: string, remoteBase: string) =>
    invoke<void>('sync_v2_test_connection', { url, username, password, remoteBase }),

  applyConfig: () =>
    invoke<void>('sync_v2_apply_config'),

  // Global WebDAV config (connection model)
  getGlobalConnection: () =>
    invoke<{ url: string; username: string; password: string; label: string } | null>('sync_v2_get_global_connection'),

  // Zombie cleanup (NAS .md missing → local cleanup)
  cleanupZombies: () =>
    invoke<{ zombiesCleaned: number; cleanedNotes: string[]; errors: string[] }>('sync_v2_cleanup_zombies'),

  // Realtime mode
  setRealtime: (enabled: boolean) =>
    invoke<void>('sync_v2_set_realtime', { enabled }),

  getRealtime: () =>
    invoke<boolean>('sync_v2_get_realtime'),

  // NAS reachability (offline detection)
  getOnline: () =>
    invoke<boolean>('sync_v2_get_online'),

  // User-facing pause toggle
  getEnabled: () =>
    invoke<boolean>('sync_v2_get_enabled'),

  setEnabled: (enabled: boolean) =>
    invoke<void>('sync_v2_set_enabled', { enabled }),

  // Vault rename / delete by explicit path. Vault MUST NOT be the
  // currently-open one — backend refuses defensively, frontend should
  // already disable the button on the active vault item.
  renameVaultAtPath: (remotePath: string, localPath: string, newName: string) =>
    invoke<{ newLocalPath: string; newRemotePath: string }>(
      'sync_v2_rename_vault_at_path', { remotePath, localPath, newName }
    ),

  deleteVaultAtPath: (remotePath: string, localPath: string, deleteRemote: boolean) =>
    invoke<{ localRemoved: boolean; remoteRemoved: boolean; configRemoved: boolean }>(
      'sync_v2_delete_vault_at_path', { remotePath, localPath, deleteRemote }
    ),

  /** `remote_base` of the currently-open vault, or null if none open. */
  activeVaultRemotePath: () =>
    invoke<string | null>('sync_v2_active_vault_remote_path'),

  // Orphan local-cache cleanup
  listOrphanLocalDirs: (knownNasVaultNames: string[]) =>
    invoke<Array<{
      localPath: string;
      name: string;
      fileCount: number;
      sizeBytes: number;
      alreadyQuarantined: boolean;
    }>>('sync_v2_list_orphan_local_dirs', { knownNasVaultNames }),

  deleteOrphanLocalDirs: (paths: string[]) =>
    invoke<Array<{
      localPath: string;
      removed: boolean;
      error: string | null;
    }>>('sync_v2_delete_orphan_local_dirs', { paths }),

  // 3-way text merge suggestion (preview only — does not apply)
  smartMerge: (noteId: string, localHash: string, remoteHash: string) =>
    invoke<{ merged: string; clean: boolean; conflictCount: number }>(
      'sync_v2_smart_merge', { noteId, localHash, remoteHash }
    ),

  // One-click smart merge with a chosen branch. Returns Success if the
  // merge was clean and got applied + branches deleted + pushed;
  // Conflict if it had conflict regions (UI falls back to manual 2-way);
  // NoCommonAncestor if the histories diverged without a shared base.
  smartMergeBranch: (noteId: string, branchId: string) =>
    invoke<
      | { kind: 'success'; mergedHash: string }
      | { kind: 'conflict'; conflictCount: number }
      | { kind: 'no_common_ancestor' }
    >('sync_v2_smart_merge_branch', { noteId, branchId }),

  // Trash panel (browse / restore / purge)
  listTrash: () =>
    invoke<Array<{
      note_id: string;
      original_path: string;
      deleted_at: string;
      trash_filename: string;
    }>>('sync_v2_list_trash'),

  restoreFromTrash: (noteId: string) =>
    invoke<void>('sync_v2_restore_from_trash', { noteId }),

  purgeTrashEntry: (noteId: string) =>
    invoke<void>('sync_v2_purge_trash_entry', { noteId }),

  purgeExpiredTrash: () =>
    invoke<number>('sync_v2_purge_expired_trash'),

  // Track H: NAS-deletion pending confirm
  listPendingNasDeletions: () =>
    invoke<Array<{
      noteId: string;
      relativePath: string;
      headHash: string;
      detectedAt: string;
    }>>('sync_v2_list_pending_nas_deletions'),

  confirmNasDeletionsTrash: () =>
    invoke<number>('sync_v2_confirm_nas_deletions_trash'),

  confirmNasDeletionsReject: () =>
    invoke<number>('sync_v2_confirm_nas_deletions_reject'),

  // Stale duplicate ref cleanup (post-Phase 3 hotfix)
  cleanupStaleRefs: () =>
    invoke<{
      duplicateGroups: number;
      deletedCount: number;
      keptIds: string[];
      errors: string[];
    }>('sync_v2_cleanup_stale_refs'),

  // ── Track B Phase B-2 — Attachments ────────────────────────────────────
  // Pass either `notePath` (absolute .md path — what drag-drop has) or
  // `noteId` (14-digit frontmatter id). Backend accepts either.
  attachmentAdd: (
    sourcePath: string,
    target: { notePath: string } | { noteId: string },
  ) =>
    invoke<AttachmentRefDto>('attachment_add', {
      sourcePath,
      notePath: 'notePath' in target ? target.notePath : undefined,
      noteId: 'noteId' in target ? target.noteId : undefined,
    }),

  attachmentDelete: (attachmentId: string) =>
    invoke<void>('attachment_delete', { attachmentId }),

  attachmentLinkToNote: (attachmentId: string, noteId: string) =>
    invoke<void>('attachment_link_to_note', { attachmentId, noteId }),

  attachmentUnlinkFromNote: (attachmentId: string, noteId: string) =>
    invoke<void>('attachment_unlink_from_note', { attachmentId, noteId }),

  attachmentListForNote: (noteId: string) =>
    invoke<AttachmentRefDto[]>('attachment_list_for_note', { noteId }),

  attachmentMigrationStatus: () =>
    invoke<{ needsMigration: boolean }>('attachment_migration_status'),

  attachmentMigrationRun: () =>
    invoke<AttachmentMigrationReport>('attachment_migration_run'),
};

// ── Track B Phase B-2 — DTO types ──────────────────────────────────────────
export type AttachmentRefDto = {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  tier: 'image' | 'pdf' | 'document' | 'csv' | 'video' | 'audio' | 'other';
  displayPath: string;
  linkedNotes: string[];
  syncEtag: string | null;
};

export type AttachmentMigrationReport = {
  total_files: number;
  migrated: number;
  deduped: number;
  collisions: number;
  duration_ms: number;
  legacy_backup_dir: string | null;
};
