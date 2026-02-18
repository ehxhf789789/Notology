import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Heading from '@tiptap/extension-heading';
import Placeholder from '@tiptap/extension-placeholder';
import { useSettingsStore } from '../stores/zustand/settingsStore';
import { t } from './i18n';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader } from '@tiptap/extension-table';
import TableCellWithColor from '../extensions/TableCellWithColor';
// Underline is included in StarterKit, no need to import separately
import ItalicCJK from '../extensions/ItalicCJK';
import WikiLink from '../extensions/WikiLink';
import Callout from '../extensions/Callout';
import ParagraphWithIndent from '../extensions/ParagraphWithIndent';
import CommentMarks from '../extensions/CommentMarks';
import HorizontalRuleNoGap from '../extensions/HorizontalRuleNoGap';
import LinkCard from '../extensions/LinkCard';
import WikiLinkSuggestion from '../extensions/WikiLinkSuggestion';
import AttachmentSuggestion from '../extensions/AttachmentSuggestion';
import { createWikiLinkSuggestion } from './wikiLinkSuggestion';
import { createAttachmentSuggestion } from './attachmentSuggestion';
import type { FileNode } from '../types';

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// Callback refs that can be updated without recreating extensions
interface EditorCallbacks {
  onClickLink: (name: string) => void;
  onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) => void;
  resolveLink: (name: string) => boolean;
  getNoteType: (name: string) => string | null;
  isAttachment: (name: string) => boolean;
  onEditorContextMenu: (pos: { x: number; y: number }) => void;
  onCommentClick: (commentId: string) => void;
  getFileTree: () => FileNode[];
  notePath: string;
  vaultPath: string;
  resolveFilePath: (name: string) => string | null;
}

interface PooledEditor {
  editor: Editor;
  inUse: boolean;
  callbacks: EditorCallbacks;
}

// Create default callbacks (no-op) for initial editor creation
function createDefaultCallbacks(): EditorCallbacks {
  return {
    onClickLink: () => {},
    onContextMenu: () => {},
    resolveLink: () => false,
    getNoteType: () => null,
    isAttachment: () => false,
    onEditorContextMenu: () => {},
    onCommentClick: () => {},
    getFileTree: () => [],
    notePath: '',
    vaultPath: '',
    resolveFilePath: () => null,
  };
}

class EditorPool {
  private pool: PooledEditor[] = [];
  private targetPoolSize: number = 8; // 8 editors for smooth multi-window experience
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private creatingInBackground: boolean = false;

  // Initialize pool - creates first editor immediately, rest in background
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initializePool();
    await this.initPromise;
  }

  private async initializePool(): Promise<void> {
    const start = performance.now();
    log(`[EditorPool] Starting initialization (target: ${this.targetPoolSize} editors)`);

    // Create first editor immediately (synchronous - will block but ensures fast first acquire)
    const firstEditor = this.createPooledEditor();
    this.pool.push(firstEditor);
    this.initialized = true; // Mark as ready after first editor
    log(`[EditorPool] First editor ready in ${(performance.now() - start).toFixed(1)}ms`);

    // Create remaining editors in background without blocking
    this.expandPoolInBackground();
  }

  private async expandPoolInBackground(): Promise<void> {
    if (this.creatingInBackground) return;
    this.creatingInBackground = true;

    const createNext = async () => {
      if (this.pool.length >= this.targetPoolSize) {
        this.creatingInBackground = false;
        log(`[EditorPool] Pool fully initialized (${this.pool.length} editors)`);
        return;
      }

      // Yield to main thread to keep UI responsive
      await new Promise(resolve => {
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(resolve, { timeout: 100 });
        } else {
          setTimeout(resolve, 16); // ~60fps frame time
        }
      });

      const editor = this.createPooledEditor();
      this.pool.push(editor);
      log(`[EditorPool] Background: Editor ${this.pool.length}/${this.targetPoolSize} created`);

      // Continue creating more
      createNext();
    };

    createNext();
  }

  private createPooledEditor(): PooledEditor {
    const callbacks = createDefaultCallbacks();
    const lang = useSettingsStore.getState().language;
    const start = performance.now();

    // Create all extensions with callback refs for dynamic updates
    const extensions = [
      StarterKit.configure({
        link: false,
        italic: false,
        paragraph: false,
        heading: false,  // 커스텀 Heading 사용
        horizontalRule: false,  // 커스텀 HorizontalRuleNoGap 사용
      }),
      HorizontalRuleNoGap,
      // 커스텀 Heading with Ctrl+1~6 단축키
      Heading.configure({
        levels: [1, 2, 3, 4, 5, 6],
      }).extend({
        addKeyboardShortcuts() {
          return {
            'Mod-1': () => this.editor.commands.toggleHeading({ level: 1 }),
            'Mod-2': () => this.editor.commands.toggleHeading({ level: 2 }),
            'Mod-3': () => this.editor.commands.toggleHeading({ level: 3 }),
            'Mod-4': () => this.editor.commands.toggleHeading({ level: 4 }),
            'Mod-5': () => this.editor.commands.toggleHeading({ level: 5 }),
            'Mod-6': () => this.editor.commands.toggleHeading({ level: 6 }),
          };
        },
      }),
      ParagraphWithIndent,
      ItalicCJK,
      Highlight,
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCellWithColor,
      TableHeader,
      // Underline is included in StarterKit
      Callout,
      // Dynamic extensions using callback refs
      WikiLink.configure({
        onClickLink: (name: string) => callbacks.onClickLink(name),
        onContextMenu: (name: string, pos: { x: number; y: number }, deleteCallback?: () => void) =>
          callbacks.onContextMenu(name, pos, deleteCallback),
        resolveLink: (name: string) => callbacks.resolveLink(name),
        getNoteType: (name: string) => callbacks.getNoteType(name),
        isAttachment: (name: string) => callbacks.isAttachment(name),
        onEditorContextMenu: (pos: { x: number; y: number }) => callbacks.onEditorContextMenu(pos),
        getNotePath: () => callbacks.notePath,
        resolveFilePath: (name: string) => callbacks.resolveFilePath(name),
      }),
      CommentMarks.configure({
        onCommentClick: (id: string) => callbacks.onCommentClick(id),
      }),
      // Suggestion extensions with callback-based getFileTree
      WikiLinkSuggestion.configure({
        suggestion: createWikiLinkSuggestion(() => callbacks.getFileTree()),
      }),
      AttachmentSuggestion.configure({
        suggestion: createAttachmentSuggestion(() => callbacks.notePath),
      }),
      LinkCard,
      Markdown.configure({
        html: true,
        transformPastedText: false,
      }),
      Placeholder.configure({
        placeholder: t('editorPlaceholder', lang),
      }),
    ];

    const editor = new Editor({
      extensions,
      content: '',
      editorProps: {
        attributes: {
          class: 'tiptap-editor hover-tiptap-editor',
          spellcheck: 'false',
        },
      },
    });

    log(`[EditorPool] Single editor created in ${(performance.now() - start).toFixed(1)}ms`);

    return {
      editor,
      inUse: false,
      callbacks,
    };
  }

  // Acquire an editor from the pool
  acquire(newCallbacks: Partial<EditorCallbacks>): Editor | null {
    const start = performance.now();

    // Find available editor
    let pooledEditor = this.pool.find(p => !p.inUse);

    // If no available editor and pool is initialized, create on demand
    if (!pooledEditor) {
      if (this.initialized) {
        log('[EditorPool] No available editor, creating on demand');
        pooledEditor = this.createPooledEditor();
        this.pool.push(pooledEditor);
        // Expand target pool size if we're running out
        if (this.pool.length >= this.targetPoolSize) {
          this.targetPoolSize = this.pool.length + 2;
          this.expandPoolInBackground();
        }
      } else {
        // Pool not initialized yet - this shouldn't happen if init() is called early
        console.warn('[EditorPool] Pool not initialized, creating editor synchronously');
        pooledEditor = this.createPooledEditor();
        this.pool.push(pooledEditor);
        this.initialized = true;
      }
    }

    pooledEditor.inUse = true;

    // Update callbacks
    Object.assign(pooledEditor.callbacks, newCallbacks);

    const elapsed = performance.now() - start;
    log(`[EditorPool] Editor acquired in ${elapsed.toFixed(1)}ms (${this.pool.filter(p => p.inUse).length}/${this.pool.length} in use)`);
    return pooledEditor.editor;
  }

  // Release editor back to pool
  release(editor: Editor): void {
    const pooledEditor = this.pool.find(p => p.editor === editor);
    if (pooledEditor) {
      pooledEditor.inUse = false;
      // Clear content for reuse
      editor.commands.clearContent();
      // Reset callbacks to default
      Object.assign(pooledEditor.callbacks, createDefaultCallbacks());
      log(`[EditorPool] Editor released (${this.pool.filter(p => p.inUse).length}/${this.pool.length} in use)`);
    }
  }

  // Update callbacks for an editor (e.g., when fileTree changes)
  updateCallbacks(editor: Editor, newCallbacks: Partial<EditorCallbacks>): void {
    const pooledEditor = this.pool.find(p => p.editor === editor);
    if (pooledEditor) {
      Object.assign(pooledEditor.callbacks, newCallbacks);
    }
  }

  // Get pool stats
  getStats(): { total: number; inUse: number; available: number } {
    const inUse = this.pool.filter(p => p.inUse).length;
    return {
      total: this.pool.length,
      inUse,
      available: this.pool.length - inUse,
    };
  }

  // Check if pool is ready (has at least one editor)
  isReady(): boolean {
    return this.initialized && this.pool.length > 0;
  }

  // Force all in-use editors to recalculate decorations
  // Called when external data (e.g., noteTypeCache) changes that affects decoration rendering
  refreshDecorations(): void {
    for (const pooledEditor of this.pool) {
      if (pooledEditor.inUse && !pooledEditor.editor.isDestroyed) {
        try {
          const { tr } = pooledEditor.editor.state;
          // setMeta ensures ProseMirror treats this as a meaningful state change
          // and recalculates props.decorations (wiki link note-type classes)
          tr.setMeta('externalDecorationRefresh', true);
          pooledEditor.editor.view.dispatch(tr);
        } catch {
          // Editor may be in a transitional state, ignore
        }
      }
    }
  }

  // Destroy all editors (for cleanup)
  destroy(): void {
    for (const pooledEditor of this.pool) {
      pooledEditor.editor.destroy();
    }
    this.pool = [];
    this.initialized = false;
    this.initPromise = null;
    this.creatingInBackground = false;
  }
}

// Singleton instance
export const editorPool = new EditorPool();

// Initialize pool immediately on module load
// This runs when the module is imported (early in app lifecycle)
if (typeof window !== 'undefined') {
  // Start initialization immediately - first editor will be ready ASAP
  editorPool.init().catch(console.error);
}
