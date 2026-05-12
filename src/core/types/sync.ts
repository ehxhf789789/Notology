// TypeScript types mirroring sync_v2 Rust structs.

/** Engine state snapshot (D12). */
export type SyncState =
  | { type: 'Idle' }
  | { type: 'Syncing'; started_at: string; phase: SyncPhase }
  | { type: 'Error'; message: string; last_attempt: string };

export type SyncPhase =
  | 'DetectingChanges'
  | 'PushingObjects'
  | 'SyncingRefs'
  | 'SavingBranches'
  | 'NotifyingPush'
  | 'Done';

/** Result of one sync cycle (D15). */
export interface SyncReport {
  started_at: string;
  duration_ms: number;
  objects_uploaded: number;
  objects_downloaded: number;
  refs_pushed: string[];
  refs_pulled: string[];
  unchanged_refs: number;
  conflicts_detected: number;
  branches_saved: number;
  errors: SyncPhaseError[];
  /** Track H: refs trashed because another device deleted them on NAS
   *  (count < bulk threshold; silent action). */
  nas_deleted_trashed?: number;
  /** Track H: refs awaiting user confirmation after a bulk deletion
   *  (count ≥ bulk threshold). UI must surface a banner. */
  nas_deleted_pending?: number;
}

export interface SyncPhaseError {
  phase: SyncPhase;
  message: string;
}

/** A persisted branch representing one divergent version. */
export interface Branch {
  branch_id: string;
  note_id: string;
  head_hash: string;
  source_device: string;
  created_at: string;
  schema_version: number;
}

/** A note with unresolved branches. */
export interface NoteWithConflicts {
  note_id: string;
  branches: Branch[];
  earliest_detected: string;
}
