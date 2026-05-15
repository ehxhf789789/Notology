import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import HeadingWithAlign from './extensions/HeadingWithAlign';
import { useSettingsStore } from '../stores/settingsStore';
import { t } from '../utils/i18n';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow } from '@tiptap/extension-table';
import TableCellWithColor from './extensions/TableCellWithColor';
import TableHeaderWithColor from './extensions/TableHeaderWithColor';
import CodeBlockWithHighlight from './extensions/CodeBlockWithHighlight';
import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
// Underline is included in StarterKit, no need to import separately
import ItalicCJK from './extensions/ItalicCJK';
import WikiLink from './extensions/WikiLink';
import Callout from './extensions/Callout';
import ParagraphWithIndent from './extensions/ParagraphWithIndent';
import CommentMarks from './extensions/CommentMarks';
import HorizontalRuleNoGap from './extensions/HorizontalRuleNoGap';
import LinkCard from './extensions/LinkCard';
import { MathInline, MathBlock, MathTrigger } from './extensions/MathExtension';
import { MathCursorPlugin } from './extensions/MathCursorPlugin';
import 'katex/dist/katex.min.css';
import WikiLinkSuggestion from './extensions/WikiLinkSuggestion';
import AttachmentSuggestion from './extensions/AttachmentSuggestion';
import { SlashCommand } from './extensions/SlashCommand';
import { createWikiLinkSuggestion } from '../../features/suggestions/wikiLinkSuggestion';
import { createAttachmentSuggestion } from '../../features/suggestions/attachmentSuggestion';
import { createSlashCommandSuggestion } from '../../features/slash-command';
import type { FileNode } from '../types';

const DEV = import.meta.env.DEV;
const log = DEV ? console.log.bind(console) : () => {};

// Create lowlight instance and register languages
const lowlight = createLowlight();
lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('python', python);
lowlight.register('py', python);
lowlight.register('css', css);
lowlight.register('json', json);
lowlight.register('html', xml);
lowlight.register('xml', xml);
lowlight.register('bash', bash);
lowlight.register('sh', bash);
lowlight.register('shell', bash);
lowlight.register('sql', sql);
lowlight.register('java', java);
lowlight.register('cpp', cpp);
lowlight.register('c++', cpp);
lowlight.register('csharp', csharp);
lowlight.register('cs', csharp);
lowlight.register('go', go);
lowlight.register('rust', rust);
lowlight.register('rs', rust);
lowlight.register('ruby', ruby);
lowlight.register('rb', ruby);
lowlight.register('php', php);
lowlight.register('swift', swift);
lowlight.register('kotlin', kotlin);
lowlight.register('kt', kotlin);
lowlight.register('yaml', yaml);
lowlight.register('yml', yaml);
lowlight.register('markdown', markdownLang);
lowlight.register('md', markdownLang);

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

    const createBatch = async () => {
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

      // Create up to 2 editors per idle frame to halve total initialization time
      const count = Math.min(2, this.targetPoolSize - this.pool.length);
      for (let i = 0; i < count; i++) {
        const editor = this.createPooledEditor();
        this.pool.push(editor);
      }
      log(`[EditorPool] Background: ${this.pool.length}/${this.targetPoolSize} editors created`);

      // Continue creating more
      createBatch();
    };

    createBatch();
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
        codeBlock: false,  // 커스텀 CodeBlockWithHighlight 사용
      }),
      CodeBlockWithHighlight.configure({ lowlight }),
      HorizontalRuleNoGap,
      // 커스텀 Heading with alignment support and Ctrl+1~6 단축키
      HeadingWithAlign.configure({
        levels: [1, 2, 3, 4, 5, 6],
      }),
      ParagraphWithIndent,
      ItalicCJK,
      Highlight,
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.extend({
        addStorage() {
          return {
            markdown: {
              serialize(state: any, node: any) {
                let hasCellColor = false;
                node.descendants?.((child: any) => {
                  if ((child.type.name === 'tableCell' || child.type.name === 'tableHeader') && child.attrs.backgroundColor) {
                    hasCellColor = true;
                    return false;
                  }
                });

                if (hasCellColor) {
                  const { getHTMLFromFragment } = require('@tiptap/core');
                  const { Fragment } = require('@tiptap/pm/model');
                  const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
                  state.write(html);
                  state.closeBlock(node);
                } else {
                  state.inTable = true;
                  node.forEach((row: any, _p: any, i: number) => {
                    state.write('| ');
                    row.forEach((col: any, _p2: any, j: number) => {
                      if (j) state.write(' | ');
                      const cellContent = col.firstChild;
                      if (cellContent?.textContent?.trim()) {
                        state.renderInline(cellContent);
                      }
                    });
                    state.write(' |');
                    state.ensureNewLine();
                    if (!i) {
                      const delimiterRow = Array.from({ length: row.childCount }).map(() => '---').join(' | ');
                      state.write(`| ${delimiterRow} |`);
                      state.ensureNewLine();
                    }
                  });
                  state.closeBlock(node);
                  state.inTable = false;
                }
              },
              parse: {},
            },
          };
        },
      }).configure({ resizable: false }),
      TableRow,
      TableCellWithColor,
      TableHeaderWithColor,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
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
      MathInline,
      MathBlock,
      MathTrigger,
      MathCursorPlugin,
      SlashCommand.configure({
        suggestion: createSlashCommandSuggestion(),
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
