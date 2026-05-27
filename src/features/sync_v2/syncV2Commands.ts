// Tauri command wrappers for sync_v2 backend.

import { invoke } from '@tauri-apps/api/core';
import { EventBus } from '../../core/infrastructure/eventBus';
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
  //
  // All mutating wrappers emit EventBus `attachment:saved` / `attachment:deleted`
  // on success so the frontend attachmentStore refreshes its index. Without
  // this, wikilink chips would render gray (unresolved) until the next
  // explicit hydrate.
  attachmentAdd: async (
    sourcePath: string,
    target: { notePath: string } | { noteId: string },
  ): Promise<AttachmentRefDto> => {
    const ref = await invoke<AttachmentRefDto>('attachment_add', {
      sourcePath,
      notePath: 'notePath' in target ? target.notePath : undefined,
      noteId: 'noteId' in target ? target.noteId : undefined,
    });
    EventBus.emit('attachment:saved', { path: ref.displayPath });
    return ref;
  },

  attachmentDelete: async (attachmentId: string): Promise<void> => {
    await invoke<void>('attachment_delete', { attachmentId });
    EventBus.emit('attachment:deleted', { path: attachmentId });
  },

  /**
   * @deprecated 2026-05-24 (HanBin) — B-model migration.
   *
   * Appending another note to an existing ref's `linked_notes` violates
   * the per-note isolation invariant (one ref → one note). Use the
   * drag-in workflow (which calls `attachmentAdd` and creates a fresh
   * per-note ref backed by the same CAS blob), or rely on the
   * `attachment_reconcile` auto-pipeline that clones refs for notes
   * with chip-only references.
   *
   * Kept in the surface for the `vault_repair` flow (Batch 2) which
   * needs the raw primitive while splitting legacy shared refs.
   */
  attachmentLinkToNote: async (attachmentId: string, noteId: string): Promise<void> => {
    await invoke<void>('attachment_link_to_note', { attachmentId, noteId });
    EventBus.emit('attachment:saved', { path: attachmentId });
  },

  attachmentUnlinkFromNote: async (attachmentId: string, noteId: string): Promise<void> => {
    await invoke<void>('attachment_unlink_from_note', { attachmentId, noteId });
    EventBus.emit('attachment:saved', { path: attachmentId });
  },

  /**
   * Track B Phase B-3 PART 6 — unlink-or-delete (Option C, HanBin 2026-05-13).
   * Returns true if the attachment was fully hard-deleted (this note held the
   * last link), false if other notes still reference it.
   */
  attachmentUnlinkOrDelete: async (attachmentId: string, noteId: string): Promise<boolean> => {
    const wasDeleted = await invoke<boolean>('attachment_unlink_or_delete', { attachmentId, noteId });
    if (wasDeleted) {
      EventBus.emit('attachment:deleted', { path: attachmentId });
    } else {
      EventBus.emit('attachment:saved', { path: attachmentId });
    }
    return wasDeleted;
  },

  attachmentListForNote: (noteId: string) =>
    invoke<AttachmentRefDto[]>('attachment_list_for_note', { noteId }),

  /**
   * Track B Phase B-3 PART 6 — force a stuck attachment back onto the
   * dirty queue. The chip's "Retry sync" context-menu action calls this.
   */
  attachmentRetry: (attachmentId: string): Promise<void> =>
    invoke<void>('sync_v2_retry_attachment', { attachmentId }),

  /**
   * Track B Phase B-3 PART 6 — bidirectional reconcile (HanBin 2026-05-13).
   * Returns the report of three discrepancy buckets; caller is expected
   * to show it to the user before calling `attachmentReconcileApply`.
   */
  attachmentReconcile: (): Promise<AttachmentReconcileReport> =>
    invoke<AttachmentReconcileReport>('attachment_reconcile'),

  /** Apply fixes from a prior reconcile report. */
  attachmentReconcileApply: (report: AttachmentReconcileReport): Promise<AttachmentReconcileApplyOutcome> =>
    invoke<AttachmentReconcileApplyOutcome>('attachment_reconcile_apply', { report }),

  /** Track B Phase B-3: full index for the redesigned Attachments tab + resolver. */
  attachmentListAll: () => invoke<AttachmentRefDto[]>('attachment_list_all'),

  /**
   * 2026-05-24 (HanBin) — full `note_id → vault_relative_path` map for
   * every .md in the vault. Backend uses the SAME resolution rule as
   * `apply.rs` (frontmatter `id:` or filename-stem fallback), so the
   * AttachmentsTab filter sees identical note-id semantics as the
   * graph view. Replaces the previous client-side reliance on
   * `contentCacheStore.metadataCache` which only had entries for
   * already-opened notes.
   *
   * Returns: { [noteIdLowercase: string]: vaultRelativePath }
   */
  noteIdIndex: () => invoke<Record<string, string>>('note_id_index'),

  /** Resolve attachment_id → absolute local CAS blob path (for startDrag). */
  attachmentLocalPath: (attachmentId: string) =>
    invoke<string>('attachment_local_path', { attachmentId }),

  attachmentMigrationStatus: () =>
    invoke<{ needsMigration: boolean }>('attachment_migration_status'),

  attachmentMigrationRun: () =>
    invoke<AttachmentMigrationReport>('attachment_migration_run'),

  // ── vault_repair (2026-05-24 HanBin) ──────────────────────────────
  /**
   * Read-only scan for 7 vault inconsistency patterns. Safe to call
   * repeatedly; never mutates state. Returns aggregated counts +
   * sampled findings. The frontend uses this to decide whether to
   * surface the repair dialog (legacy vault detection).
   */
  vaultRepairScan: (): Promise<VaultRepairReport> =>
    invoke<VaultRepairReport>('vault_repair_scan'),

  /**
   * Execute fixes from a prior `vaultRepairScan`. Backs up to
   * `.legacy/repair_<ts>/` before any write — zero data loss guarantee.
   * Returns counts per pattern + error list + backup directory path.
   * Caller should run `vaultRepairVerify` afterwards to confirm.
   */
  vaultRepairApply: (
    report: VaultRepairReport,
    options?: VaultRepairApplyOptions,
  ): Promise<VaultRepairOutcome> =>
    invoke<VaultRepairOutcome>('vault_repair_apply', { report, options }),

  /** Post-apply consistency check. Empty list = pass. */
  vaultRepairVerify: (): Promise<VaultRepairVerificationFailure[]> =>
    invoke<VaultRepairVerificationFailure[]>('vault_repair_verify'),

  /** Stage A — poll repair status. Returns `Idle` when no apply is running. */
  vaultRepairStatus: (): Promise<VaultRepairProgress> =>
    invoke<VaultRepairProgress>('vault_repair_status'),

  /** Stage A — request cancellation of the in-flight apply (cooperative). */
  vaultRepairCancel: (): Promise<void> =>
    invoke<void>('vault_repair_cancel'),

  // Phase 1 B1+B2+B3 (2026-05-24) — snapshot management API.
  /**
   * Create a full vault snapshot with sha256 integrity manifest.
   * Stored OUTSIDE the vault (LOCALAPPDATA) so it never syncs.
   * Returns the manifest; the `snapshotId` is what you'd pass to
   * `vaultSnapshotRestore` / `vaultSnapshotDelete`.
   */
  vaultSnapshotCreate: (label?: string): Promise<VaultSnapshotManifest> =>
    invoke<VaultSnapshotManifest>('vault_snapshot_create', { label: label ?? null }),

  /** List all snapshots known for the currently-open vault. */
  vaultSnapshotList: (): Promise<VaultSnapshotInfo[]> =>
    invoke<VaultSnapshotInfo[]>('vault_snapshot_list'),

  /**
   * Restore the vault to a snapshot. DESTRUCTIVE — overwrites every
   * vault file with its snapshot version + deletes files not in the
   * manifest. Caller MUST get explicit user confirmation. UI should
   * also offer to take a fresh snapshot first (undo-the-undo).
   */
  vaultSnapshotRestore: (snapshotId: string): Promise<VaultSnapshotRestoreOutcome> =>
    invoke<VaultSnapshotRestoreOutcome>('vault_snapshot_restore', { snapshotId }),

  /**
   * P1 #6 — preview a restore without executing it. Returns lists of
   * files that would be overwritten and DELETED. UI must show the
   * delete list to the user before confirming restore (otherwise
   * restore silently destroys files made after the snapshot).
   */
  vaultSnapshotPreviewRestore: (snapshotId: string): Promise<VaultSnapshotRestorePreview> =>
    invoke<VaultSnapshotRestorePreview>('vault_snapshot_preview_restore', { snapshotId }),

  /** Delete a snapshot (frees disk space). Manual / user-driven only. */
  vaultSnapshotDelete: (snapshotId: string): Promise<void> =>
    invoke<void>('vault_snapshot_delete', { snapshotId }),

  /**
   * Phase 5 B8 (2026-05-24) — clone the open vault to a sandbox location.
   * Returns the sandbox absolute path. User can then open the sandbox
   * in Notology (via VaultSelector) and run repair against it for
   * safe testing before touching the real vault.
   */
  vaultSandboxCreate: (label?: string): Promise<VaultSandboxOutcome> =>
    invoke<VaultSandboxOutcome>('vault_sandbox_create', { label: label ?? null }),

  // ── Round 2 R5 v5 — pending / failed sync ops introspection ──────────────
  /** All entries currently in the active dirty queue (will be retried). */
  listPending: (): Promise<PendingOpDto[]> =>
    invoke<PendingOpDto[]>('sync_v2_list_pending'),

  /** All entries dropped after max retries (need user action). */
  listFailed: (): Promise<FailedOpDto[]> =>
    invoke<FailedOpDto[]>('sync_v2_list_failed'),

  /** Re-enqueue one failed entry. */
  retryFailed: (failedId: number): Promise<void> =>
    invoke<void>('sync_v2_retry_failed', { failedId }),

  /** Re-enqueue every failed entry. Returns count re-enqueued. */
  retryAllFailed: (): Promise<number> =>
    invoke<number>('sync_v2_retry_all_failed'),

  /** Clear the failed list (user dismisses). */
  clearFailed: (): Promise<number> =>
    invoke<number>('sync_v2_clear_failed'),

  /** Just the count of permanently failed entries. */
  countFailed: (): Promise<number> =>
    invoke<number>('sync_v2_count_failed'),
};

// ── Round 2 R5 v5 — sync queue introspection DTOs ──────────────────────────
export type PendingOpDto = {
  id: number;
  opType:
    | 'note_upsert'
    | 'note_delete'
    | 'note_move'
    | 'attachment_upsert'
    | 'attachment_delete'
    | 'folder_create'
    | 'folder_delete'
    | 'yaml_change'
    | 'meta_change';
  targetPath: string;
  timestampMs: number;
  retryCount: number;
  lastError: string | null;
  lane: 'fast' | 'slow';
};

export type FailedOpDto = {
  id: number;
  opType: PendingOpDto['opType'];
  targetPath: string;
  queuedAtMs: number;
  failedAtMs: number;
  lastError: string;
  lane: 'fast' | 'slow';
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

// ── Track B Phase B-3 PART 6 — reconcile DTOs ──────────────────────────────
export type AttachmentDummyChip = {
  notePath: string;
  noteId: string;
  fileName: string;
};

export type AttachmentLinkDiscrepancy = {
  attachmentId: string;
  originalName: string;
  noteId: string;
};

export type AttachmentReconcileReport = {
  dummyChips: AttachmentDummyChip[];
  staleRefLinks: AttachmentLinkDiscrepancy[];
  missingRefLinks: AttachmentLinkDiscrepancy[];
  notesScanned: number;
  refsInspected: number;
};

export type AttachmentReconcileApplyOutcome = {
  dummyChipsRemoved: number;
  staleLinksFixed: number;
  missingLinksAdded: number;
  refsHardDeleted: number;
  errors: string[];
};

// ─── vault_repair (2026-05-24 HanBin) — 7-pattern legacy + drift fixer ───

export type VaultRepairFindingKind =
  | 'legacy_att_folder'
  | 'sketch_external_path'
  | 'sketch_unresolved_ref'
  | 'wikilink_resolvable'
  | 'wikilink_broken'
  | 'shared_ref'
  | 'orphan_blob';

export type VaultRepairFinding = {
  kind: VaultRepairFindingKind;
  target: string;
  detail: string | null;
  autoFixable: boolean;
};

export type VaultRepairPatternCount = {
  legacyAttFolder: number;
  sketchExternalPath: number;
  sketchUnresolvedRef: number;
  wikilinkResolvable: number;
  wikilinkBroken: number;
  sharedRef: number;
  orphanBlob: number;
};

export type VaultRepairReport = {
  counts: VaultRepairPatternCount;
  findings: VaultRepairFinding[];
  vaultRoot: string;
  repairRecommended: boolean;
};

export type VaultRepairApplyOptions = {
  autoOnly: boolean;
  skipOrphanSweep: boolean;
  /** Phase 1 B1 — bypass the mandatory pre-apply snapshot. Default false. */
  skipSnapshot?: boolean;
  /** Phase 2 B4 — dry run: snapshot only, no destructive writes. */
  dryRun?: boolean;
};

export type VaultSnapshotEntry = {
  relPath: string;
  sizeBytes: number;
  sha256: string;
};

export type VaultSnapshotManifest = {
  snapshotId: string;
  startedAt: string;
  completedAt: string | null;
  sourceVault: string;
  label: string;
  fileCount: number;
  totalBytes: number;
  entries: VaultSnapshotEntry[];
};

export type VaultSnapshotInfo = {
  snapshotId: string;
  label: string;
  startedAt: string;
  completedAt: string | null;
  fileCount: number;
  totalBytes: number;
  dir: string;
  complete: boolean;
};

export type VaultSnapshotRestoreOutcome = {
  snapshotId: string;
  filesRestored: number;
  filesDeleted: number;
  errors: string[];
};

export type VaultSnapshotRestorePreview = {
  snapshotId: string;
  filesToOverwrite: string[];
  filesToDelete: string[];
  filesUnchanged: number;
  bytesToOverwrite: number;
};

export type VaultSandboxOutcome = {
  sandboxPath: string;
  sourceVault: string;
  filesCopied: number;
  bytesCopied: number;
  errors: string[];
};

export type VaultRepairOutcome = {
  legacyAttMigrated: number;
  sketchExternalImported: number;
  sketchUnresolvedImported: number;
  wikilinkResolved: number;
  sharedRefsSplit: number;
  orphanBlobsSwept: number;
  errors: string[];
  backupDir: string;
  /** Phase 1 B3 — id of the pre-apply safety snapshot. UI uses this
   *  for the "Restore" affordance if anything went wrong. */
  snapshotId?: string | null;
  /** Phase 2 B4 — true iff this run was a dry-run (no destructive writes). */
  wasDryRun?: boolean;
};

export type VaultRepairVerificationFailure = {
  kind: string;
  detail: string;
};

export type VaultRepairStage =
  | 'idle'
  | 'scanning'
  | 'backing_up'
  | 'p1_legacy_att'
  | 'p2_p3_sketch'
  | 'p4_wikilink'
  | 'p6_split_shared_ref'
  | 'p7_orphan_sweep'
  | 'p8_purge_bogus_md'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type VaultRepairProgress = {
  stage: VaultRepairStage;
  current: number;
  total: number;
  message: string;
  cancelRequested: boolean;
  elapsedMs: number;
};

export type AttachmentMigrationReport = {
  total_files: number;
  migrated: number;
  deduped: number;
  collisions: number;
  duration_ms: number;
  legacy_backup_dir: string | null;
};
