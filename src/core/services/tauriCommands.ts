import { invoke } from '../../web/core';
import type {
  FileNode, FileContent, SearchResult, NoteMetadata, NoteFilter, AttachmentInfo,
  CalendarMemo, LockAcquireResult, NasPlatformInfo, GraphData,
} from '../types';
import { EventBus } from '../infrastructure/eventBus';

// Types not in ../types - defined locally
export interface FrontmatterOnly {
  path: string;
  frontmatter: string | null;
  mtime: number;
}

export interface FileMeta {
  path: string;
  mtime: number;
}

export interface UrlMetadata {
  title: string;
  description: string;
  image: string;
  favicon: string;
}

// AttachmentFileInfo + readAttachmentFolder removed 2026-05-14 (HanBin).
// The `//` attachment-recall command used to enumerate the `_att/` per-note
// folder via this Tauri call; it now reads from the in-memory
// AttachmentRef store (`useAttachmentStore.listForNote`). No callers remain.

// ============================================================================
// File Commands
// ============================================================================

export const fileCommands = {
  readDirectory: (path: string) =>
    invoke<FileNode[]>('read_directory', { path }),

  readFile: (path: string) =>
    invoke<FileContent>('read_file', { path }),

  writeFile: (path: string, frontmatter: string | null, body: string) =>
    invoke<void>('write_file', { path, frontmatter, body }).then(() => {
      EventBus.emit('file:saved', { path });
      // 관찰 ①-g: 무엇을 고쳐 쓰는가 — 경로만, 본문은 안 보낸다 (2-14-2-1)
      import('../../features/dobbin/observe').then(m => m.observe('edit_note', path)).catch(() => {});
    }),

  deleteFile: (path: string) =>
    invoke<void>('delete_file', { path }).then(() => {
      EventBus.emit('file:deleted', { path });
    }),

  deleteFolder: (path: string) =>
    invoke<void>('delete_folder', { path }).then(() => {
      EventBus.emit('folder:deleted', { path });
    }),

  moveFile: (oldPath: string, newPath: string) =>
    invoke<void>('move_file', { oldPath, newPath }).then(() => {
      EventBus.emit('file:renamed', { oldPath, newPath });
    }),

  ensureDirectory: (path: string) =>
    invoke<void>('ensure_directory', { path }),

  readTextFile: (path: string) =>
    invoke<string>('read_text_file', { path }),

  checkFileExists: (path: string) =>
    invoke<boolean>('check_file_exists', { path }),

  listFilesInDirectory: (path: string, extension: string) =>
    invoke<string[]>('list_files_in_directory', { path, extension }),

  getFileMtime: (path: string) =>
    invoke<number>('get_file_mtime', { path }),
};

// ============================================================================
// Note Commands
// ============================================================================

export const noteCommands = {
  createNote: (dirPath: string, title: string) =>
    invoke<string>('create_note', { dirPath, title }).then((path) => {
      EventBus.emit('file:saved', { path });
      return path;
    }),

  createFolder: (parentPath: string, name: string, templateFrontmatter: string | null, templateBody: string) =>
    invoke<string>('create_folder', { parentPath, name, templateFrontmatter, templateBody }).then((path) => {
      EventBus.emit('folder:created', { path });
      return path;
    }),

  createNoteWithTemplate: (dirPath: string, fileName: string, frontmatterYaml: string, body: string) =>
    invoke<string>('create_note_with_template', { dirPath, fileName, frontmatterYaml, body }).then((path) => {
      EventBus.emit('file:saved', { path });
      return path;
    }),

  deleteNote: (notePath: string) =>
    invoke<void>('delete_note', { notePath }).then(() => {
      EventBus.emit('file:deleted', { path: notePath });
      // Also sync _att folder deletion
      const stem = notePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const dir = notePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      EventBus.emit('folder:deleted', { path: `${dir}/${stem}_att` });
    }),

  moveNote: (notePath: string, newDir: string) =>
    invoke<string>('move_note', { notePath, newDir }).then((newPath) => {
      EventBus.emit('file:renamed', { oldPath: notePath, newPath });
      // Sync _att folder move
      const stem = notePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const oldDir = notePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const newNoteDir = newPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      EventBus.emit('folder:renamed', { oldPath: `${oldDir}/${stem}_att`, newPath: `${newNoteDir}/${stem}_att` });
      return newPath;
    }),

  renameFileWithLinks: (filePath: string, newName: string, vaultPath: string) =>
    invoke<string>('rename_file_with_links', { filePath, newName, vaultPath }).then((newPath) => {
      EventBus.emit('file:renamed', { oldPath: filePath, newPath });
      // Sync _att folder rename (old_att → new_att)
      const oldStem = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const newStem = newPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      if (oldStem !== newStem) {
        const oldDir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const newDir = newPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        EventBus.emit('folder:renamed', { oldPath: `${oldDir}/${oldStem}_att`, newPath: `${newDir}/${newStem}_att` });
      }
      return newPath;
    }),

  updateFrontmatter: (notePath: string, newFrontmatterYaml: string) =>
    invoke<void>('update_note_frontmatter', { notePath, newFrontmatterYaml }).then(() => {
      EventBus.emit('file:saved', { path: notePath });
    }),

  touchNoteModified: (notePath: string) =>
    invoke<void>('touch_note_modified', { notePath }),

  importAttachment: (sourcePath: string, notePath: string) =>
    invoke<string>('import_attachment', { sourcePath, notePath }).then((path) => {
      EventBus.emit('attachment:saved', { path });
      return path;
    }),

  importFile: (sourcePath: string, vaultPath: string, targetDir: string | null) =>
    invoke<string>('import_file', { sourcePath, vaultPath, targetDir }).then((path) => {
      EventBus.emit('file:saved', { path });
      return path;
    }),
};

// ============================================================================
// Search Commands
// ============================================================================

export const searchCommands = {
  initIndex: (vaultPath: string) =>
    invoke<void>('init_search_index', { vaultPath }),

  resetSearchState: () =>
    invoke<void>('reset_search_state'),

  fullTextSearch: (query: string, limit?: number, fast?: boolean) =>
    invoke<SearchResult[]>('full_text_search', { query, limit, fast }),

  queryNotes: (filter: NoteFilter) =>
    invoke<NoteMetadata[]>('query_notes', { filter }),

  indexNote: (path: string) =>
    invoke<void>('index_note', { path }),

  removeFromIndex: (path: string) =>
    invoke<void>('remove_note_from_index', { path }),

  reindexVault: () =>
    invoke<void>('reindex_vault'),

  clearIndex: (vaultPath: string) =>
    invoke<void>('clear_search_index', { vaultPath }),

  /**
   * @deprecated 2026-05-20 — desktop migrated to AttachmentRef store
   * (`useAttachmentStore`). Only `src/features/mobile/views/SearchView.tsx`
   * still calls this; the Rust command + this wrapper are scheduled for
   * removal once mobile finishes the same migration. Don't add new
   * call sites.
   */
  searchAttachments: (vaultPath: string, query: string) =>
    invoke<AttachmentInfo[]>('search_attachments', { vaultPath, query }),

  getAllUsedTags: () =>
    invoke<string[]>('get_all_used_tags'),

  getSuggestionTerms: (limit?: number) =>
    invoke<[string, number][]>('get_suggestion_terms', { limit }),

  deleteMultipleFiles: (paths: string[]) =>
    invoke<number>('delete_multiple_files', { paths }),

  deleteAttachmentsWithLinks: (paths: string[]) =>
    invoke<[number, number, string[]]>('delete_attachments_with_links', { paths }).then((result) => {
      for (const p of paths) {
        EventBus.emit('attachment:deleted', { path: p });
      }
      return result;
    }),

  getGraphData: (containerPath?: string | null, includeAttachments?: boolean) =>
    invoke<GraphData>('get_graph_data', { containerPath: containerPath ?? null, includeAttachments: includeAttachments ?? false }),

  bulkDeleteTag: (tag: string) =>
    invoke<{ affected_count: number; failed_paths: string[]; cancelled: boolean }>('bulk_delete_tag', { tag }),

  bulkRenameTag: (oldTag: string, newTag: string) =>
    invoke<{ affected_count: number; failed_paths: string[]; cancelled: boolean }>('bulk_rename_tag', { oldTag, newTag }),

  bulkAddTags: (paths: string[], tag: string) =>
    invoke<{ affected_count: number; failed_paths: string[]; cancelled: boolean }>('bulk_add_tags', { paths, tag }),

  cancelBulkOperation: () =>
    invoke<void>('cancel_bulk_operation'),
};

// ============================================================================
// Memo Commands
// ============================================================================

export interface CommentsWithMtime {
  comments: string;
  mtime: number;
}

export const memoCommands = {
  readComments: (notePath: string) =>
    invoke<CommentsWithMtime>('read_comments', { notePath }),

  writeComments: (notePath: string, commentsJson: string) =>
    invoke<number>('write_comments', { notePath, commentsJson }).then((mtime) => {
      // Comments are stored in {noteStem}_att/comments.json
      const stem = notePath.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || '';
      const dir = notePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const commentsPath = `${dir}/${stem}_att/comments.json`;
      EventBus.emit('comments:saved', { notePath, commentsPath });
      return mtime;
    }),

  indexNoteMemos: (notePath: string) =>
    invoke<void>('index_note_memos', { notePath }),

  collectCalendarMemos: (containerPath: string) =>
    invoke<CalendarMemo[]>('collect_calendar_memos', { containerPath }),
};

// ============================================================================
// Vault Commands
// ============================================================================

export const vaultCommands = {
  acquireLock: (vaultPath: string, force: boolean) =>
    invoke<LockAcquireResult>('acquire_lock', { vaultPath, force }),

  releaseLock: (vaultPath: string) =>
    invoke<void>('release_lock', { vaultPath }),

  cleanupOldBackups: (vaultPath: string) =>
    invoke<number>('cleanup_old_backups', { vaultPath }),

  detectNasPlatform: (vaultPath: string) =>
    invoke<NasPlatformInfo>('detect_nas_platform', { vaultPath }),
};

// ============================================================================
// Note Lock Commands
// ============================================================================

export interface NoteLockInfo {
  machine_id: string;
  hostname: string;
  file_path: string;
  locked_at: string;
  heartbeat: string;
}

export const noteLockCommands = {
  acquireNoteLock: (vaultPath: string, notePath: string) =>
    invoke<void>('acquire_note_lock', { vaultPath, notePath }),

  releaseNoteLock: (vaultPath: string, notePath: string) =>
    invoke<void>('release_note_lock', { vaultPath, notePath }),

  updateHeartbeat: (vaultPath: string, notePath: string) =>
    invoke<void>('update_note_lock_heartbeat', { vaultPath, notePath }),

  checkNoteLock: (vaultPath: string, notePath: string) =>
    invoke<NoteLockInfo | null>('check_note_lock', { vaultPath, notePath }),
};

// ============================================================================
// Cache Commands
// ============================================================================

export const cacheCommands = {
  readMetaCache: (vaultPath: string) =>
    invoke<string>('read_meta_cache', { vaultPath }),

  writeMetaCache: (vaultPath: string, cacheJson: string) =>
    invoke<void>('write_meta_cache', { vaultPath, cacheJson }),

  readFrontmattersBatch: (paths: string[]) =>
    invoke<FrontmatterOnly[]>('read_frontmatters_batch', { paths }),

  getFilesMtime: (paths: string[]) =>
    invoke<FileMeta[]>('get_files_mtime', { paths }),
};

// ============================================================================
// Frontmatter Commands
// ============================================================================

export const frontmatterCommands = {
  parseFrontmatter: <T>(content: string) =>
    invoke<T>('parse_frontmatter', { content }),

  validateFrontmatter: <T>(frontmatterJson: string) =>
    invoke<T>('validate_frontmatter', { frontmatterJson }),

  frontmatterToYaml: (frontmatterJson: string) =>
    invoke<string>('frontmatter_to_yaml', { frontmatterJson }),

  yamlToFrontmatter: <T>(yamlStr: string) =>
    invoke<T>('yaml_to_frontmatter', { yamlStr }),
};

// ============================================================================
// Utility Commands
// ============================================================================

export const utilCommands = {
  // 🔴 웹에는 "기본 앱으로 열기"가 없다 — 받아서 여는 것이 그 자리다.
  //    이 줄이 남아 있어서 HWP·zip 같은 것은 눌러도 아무 일도 안 났다.
  openInDefaultApp: async (path: string) => {
    // 🔴 웹에는 "기본 앱으로 열기"가 없다 — **받아서 여는 것이 그 자리다.**
    //    이 줄이 데스크톱 명령을 그대로 부르고 있어서 HWP·zip 같은
    //    뷰어 미지원 형식은 눌러도 **아무 일도 안 났다** (사용자 신고).
    const { isWeb, openFile } = await import('../../web/files');
    if (isWeb()) { openFile(path); return; }
    return invoke<void>('open_in_default_app', { path });
  },

  revealInExplorer: (path: string) =>
    invoke<void>('reveal_in_explorer', { path }),

  openUrlInBrowser: (url: string) =>
    invoke<void>('open_url_in_browser', { url }),

  fetchUrlMetadata: (url: string) =>
    invoke<UrlMetadata>('fetch_url_metadata', { url }),

  toggleDevtools: () =>
    invoke<void>('toggle_devtools'),
};

// ============================================================================
// Document Preview Commands
// ============================================================================

export interface PreviewEngineInfo {
  available: boolean;
  engine: string;
  path: string | null;
}

export const previewCommands = {
  checkPreviewEngine: () =>
    invoke<PreviewEngineInfo>('check_preview_engine'),

  convertToPreviewPdf: (filePath: string) =>
    invoke<string>('convert_to_preview_pdf', { filePath }),

  cleanupPreviewCache: (maxAgeDays?: number) =>
    invoke<number>('cleanup_preview_cache', { maxAgeDays }),

  readBinaryFile: (path: string) =>
    invoke<number[]>('read_binary_file', { path }),

  // HWP rendering via Rust hwpers crate
  renderHwpToSvg: (path: string) =>
    invoke<string>('render_hwp_to_svg', { path }),
};

// ─── Library & Migration Commands ──────────────────────────────────

export interface PreMigrationReport {
  needs_migration: boolean;
  total_notes: number;
  has_sync_backup: boolean;
}

export interface MigrationState {
  version: number;
  status: string;
  total_notes: number;
  migrated_notes: number;
  failed_notes: { path: string; reason: string; attempts: number }[];
  started_at: string;
  completed_at: string | null;
  last_failure_reason: string | null;
}

export const libraryCommands = {
  initLibrary: (vaultPath: string) =>
    invoke<void>('init_library_for_vault', { vaultPath }),

  clearLibrary: () =>
    invoke<void>('clear_library'),

  checkMigrationNeeded: (vaultPath: string) =>
    invoke<PreMigrationReport>('check_migration_needed', { vaultPath }),

  runMigration: (vaultPath: string) =>
    invoke<MigrationState>('run_vault_migration', { vaultPath }),

  getMigrationState: (vaultPath: string) =>
    invoke<MigrationState | null>('get_vault_migration_state', { vaultPath }),

  declineMigration: (vaultPath: string) =>
    invoke<void>('decline_vault_migration', { vaultPath }),
};

// ── Stage 4.6 Faststart bulk migration (HanBin 2026-05-14) ──

export interface FaststartReport {
  candidates: number;
  total_videos: number;
  estimated_disk_required: number;
}

export interface FaststartState {
  converted: number;
  skipped_already_faststart: number;
  failed: string[];
  backup_dir: string | null;
  duration_ms: number;
}

export const faststartMigrationCommands = {
  check: (vaultPath: string) =>
    invoke<FaststartReport>('faststart_migration_check', { vaultPath }),

  run: (vaultPath: string) =>
    invoke<FaststartState>('faststart_migration_run', { vaultPath }),

  decline: (vaultPath: string) =>
    invoke<void>('faststart_migration_decline', { vaultPath }),
};
