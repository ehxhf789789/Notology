/**
 * MathExtension — KaTeX for TipTap.
 *
 * Two node types:
 * - mathInline ($formula$): inline atom, KaTeX rendered. Click to edit.
 * - mathBlock ($$formula$$): block atom, KaTeX display mode. Click to edit.
 *
 * Loading: preprocessWikiLinks converts $...$/$$...$$ → HTML tags → parseHTML → nodes
 * Saving: serialize → $formula$ / $$formula$$
 * New input: type $ → triggers inline math creation with edit popup
 *            type $$ → triggers block math creation with edit popup
 */
import { Node, mergeAttributes, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import { MathAutocompleteController } from '@features/suggestions/mathAutocompleteSuggestion';

const MATH_DEBUG = false;

/**
 * Try to auto-fix common LaTeX errors.
 * Returns fixed string, or null if no fix available.
 */
function tryFixLatex(input: string): string | null {
  let fixed = input;

  // 1. Unmatched \begin{...} without \end{...}
  const beginMatch = fixed.match(/\\begin\{(\w+)\}/g);
  if (beginMatch) {
    for (const b of beginMatch) {
      const env = b.match(/\\begin\{(\w+)\}/)?.[1];
      if (env && !fixed.includes(`\\end{${env}}`)) {
        fixed = fixed + ` \\end{${env}}`;
      }
    }
  }

  // 2. Unmatched \end{...} without \begin{...}
  const endMatch = fixed.match(/\\end\{(\w+)\}/g);
  if (endMatch) {
    for (const e of endMatch) {
      const env = e.match(/\\end\{(\w+)\}/)?.[1];
      if (env && !fixed.includes(`\\begin{${env}}`)) {
        fixed = `\\begin{${env}} ` + fixed;
      }
    }
  }

  // 3. Unmatched braces — count { and } and add missing
  let braceDepth = 0;
  for (const ch of fixed) {
    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
  }
  if (braceDepth > 0) {
    fixed = fixed + '}'.repeat(braceDepth);
  } else if (braceDepth < 0) {
    fixed = '{'.repeat(-braceDepth) + fixed;
  }

  // 4. \left without \right (and vice versa)
  const leftCount = (fixed.match(/\\left[\s([\]{|.]/g) || []).length;
  const rightCount = (fixed.match(/\\right[\s)\]{|.]/g) || []).length;
  if (leftCount > rightCount) {
    for (let i = 0; i < leftCount - rightCount; i++) {
      fixed = fixed + ' \\right.';
    }
  } else if (rightCount > leftCount) {
    for (let i = 0; i < rightCount - leftCount; i++) {
      fixed = '\\left. ' + fixed;
    }
  }

  // 5. Common typos: #alpha → \alpha, etc.
  fixed = fixed.replace(/#(alpha|beta|gamma|delta|theta|lambda|sigma|pi|omega|mu|phi|psi|chi|rho|tau|epsilon|zeta|eta|nu|xi|kappa|iota|upsilon)/gi, '\\$1');

  // 6. Missing backslash for common commands
  fixed = fixed.replace(/(?<!\\)(frac|sqrt|sum|prod|int|lim|sin|cos|tan|log|ln|exp|det|dim|sup|inf|max|min|text|mathbb|mathcal|mathbf|mathrm)\{/g, '\\$1{');

  // 7. & without being in a matrix/aligned/cases environment
  // (don't fix this — it's intentional in environments)

  return fixed !== input ? fixed : null;
}
function mathLog(...args: any[]) {
  if (MATH_DEBUG) console.log('[MathExt]', ...args);
}

// ═══════════════════════════════════════
// NodeView
// ═══════════════════════════════════════
function createMathNodeView(isBlock: boolean) {
  return ({ node, getPos, editor }: any) => {
    const dom = document.createElement(isBlock ? 'div' : 'span');
    dom.className = `math-node ${isBlock ? 'math-block-node' : 'math-inline-node'}`;
    // NOTE: Do NOT set dom.contentEditable = 'false' here.
    // ProseMirror manages atom node boundaries. Setting contentEditable=false
    // on the outer element breaks text selection/drag across math nodes.

    const display = document.createElement(isBlock ? 'div' : 'span');
    display.className = 'math-katex';
    // Do NOT set contentEditable='false' — it blocks drag/selection across the node.
    // Instead, CSS user-select:none prevents text selection inside KaTeX output.
    dom.appendChild(display);

    const editContainer = document.createElement(isBlock ? 'div' : 'span');
    editContainer.className = `math-edit-container${isBlock ? ' math-edit-container-block' : ''}`;
    editContainer.style.display = 'none';

    const inputEl = isBlock
      ? (() => { const t = document.createElement('textarea'); t.rows = 2; t.className = 'math-edit-input math-edit-textarea'; return t; })()
      : (() => { const i = document.createElement('input'); i.type = 'text'; i.className = 'math-edit-input'; return i; })();
    inputEl.spellcheck = false;
    inputEl.setAttribute('placeholder', isBlock ? 'LaTeX 수식 입력... (Ctrl+Enter로 완료)' : 'LaTeX 수식...');

    if (isBlock) {
      // Block: just textarea, no delimiters (card border is the visual boundary)
      editContainer.appendChild(inputEl);
    } else {
      // Inline: $ input $
      const delimBefore = document.createElement('span');
      delimBefore.className = 'math-delimiter';
      delimBefore.textContent = '$';
      const delimAfter = document.createElement('span');
      delimAfter.className = 'math-delimiter';
      delimAfter.textContent = '$';
      editContainer.appendChild(delimBefore);
      editContainer.appendChild(inputEl);
      editContainer.appendChild(delimAfter);
    }
    dom.appendChild(editContainer);

    let previewContainer: HTMLDivElement | null = null;
    if (isBlock) {
      previewContainer = document.createElement('div');
      previewContainer.className = 'math-edit-preview';
      previewContainer.style.display = 'none';
      dom.appendChild(previewContainer);
    }

    let formula = node.attrs.formula;
    let editing = false;
    let finishScheduled = false;

    const autocomplete = new MathAutocompleteController();

    const render = () => {
      if (!formula) {
        display.textContent = isBlock ? '수식 입력' : '수식';
        display.classList.add('math-placeholder');
        display.classList.remove('math-render-error');
        return;
      }
      display.classList.remove('math-placeholder');

      // Try rendering, if error → show error UI with fix suggestion
      try {
        katex.render(formula, display, { throwOnError: true, displayMode: isBlock });
        display.classList.remove('math-render-error');
      } catch (err: any) {
        display.classList.add('math-render-error');
        const errorMsg = err?.message || '수식 오류';

        // Try auto-fix
        const fixed = tryFixLatex(formula);

        display.innerHTML = '';
        const errorContainer = document.createElement('span');
        errorContainer.className = 'math-error-container';

        // Error icon + original formula
        const formulaSpan = document.createElement('span');
        formulaSpan.className = 'math-error-formula';
        formulaSpan.textContent = formula;
        errorContainer.appendChild(formulaSpan);

        // Error message
        const msgSpan = document.createElement('span');
        msgSpan.className = 'math-error-msg';
        // Extract short message (first line, max 60 chars)
        const shortMsg = errorMsg.split('\n')[0].replace(/^KaTeX parse error:\s*/i, '').substring(0, 60);
        msgSpan.textContent = `⚠ ${shortMsg}`;
        errorContainer.appendChild(msgSpan);

        // Fix button (if auto-fix is available)
        if (fixed && fixed !== formula) {
          const fixBtn = document.createElement('button');
          fixBtn.className = 'math-error-fix-btn';
          fixBtn.textContent = '자동 수정';
          fixBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pos = typeof getPos === 'function' ? getPos() : null;
            if (pos !== null && pos !== undefined) {
              editor.view.dispatch(
                editor.view.state.tr.setNodeMarkup(pos, undefined, { formula: fixed })
              );
            }
          });
          errorContainer.appendChild(fixBtn);
        }

        display.appendChild(errorContainer);
      }
    };

    const startEdit = () => {
      if (editing) return;
      editing = true;
      finishScheduled = false;
      mathLog('startEdit', { formula, pos: typeof getPos === 'function' ? getPos() : '?' });


      dom.classList.add('math-editing');
      (inputEl as HTMLInputElement).value = formula;

      // Hide KaTeX display, show edit UI
      display.style.display = 'none';
      editContainer.style.display = '';

      if (isBlock && previewContainer) {
        previewContainer.style.display = '';
      }

      autocomplete.attach(inputEl as HTMLInputElement);

      requestAnimationFrame(() => {
        inputEl.focus();
        if (inputEl instanceof HTMLInputElement) inputEl.select();
        else if (inputEl instanceof HTMLTextAreaElement) {
          inputEl.selectionStart = inputEl.value.length;
          inputEl.selectionEnd = inputEl.value.length;
        }
      });
    };

    const finishEdit = (save: boolean) => {
      if (!editing) return;
      editing = false;
      finishScheduled = false;
      dom.classList.remove('math-editing');

      // Show KaTeX display, hide edit UI
      editContainer.style.display = 'none';
      display.style.display = '';

      if (isBlock && previewContainer) {
        previewContainer.style.display = 'none';
      }

      autocomplete.detach();

      const pos = typeof getPos === 'function' ? getPos() : null;
      mathLog('finishEdit', { save, pos, newFormula: (inputEl as HTMLInputElement).value.trim() });

      if (save && pos !== null && pos !== undefined) {
        const newFormula = (inputEl as HTMLInputElement).value.trim();

        if (!newFormula) {
          mathLog('finishEdit: deleting empty node');
          const tr = editor.view.state.tr.delete(pos, pos + 1);
          try {
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), 1));
          } catch { /* ignore */ }
          editor.view.dispatch(tr);
          editor.view.focus();
          return;
        }

        if (newFormula !== formula) {
          mathLog('finishEdit: saving formula', newFormula);
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, { formula: newFormula })
          );
        }

        // Place cursor AFTER math node
        const currentPos = typeof getPos === 'function' ? getPos() : pos;
        if (currentPos !== null && currentPos !== undefined) {
          const afterPos = currentPos + 1;
          try {
            const $after = editor.view.state.doc.resolve(Math.min(afterPos, editor.view.state.doc.content.size));
            const sel = TextSelection.near($after, 1);
            mathLog('finishEdit: cursor at', sel.from);
            editor.view.dispatch(editor.view.state.tr.setSelection(sel));
          } catch (e) {
            mathLog('finishEdit: cursor failed', e);
          }
        }
      }
      render();
      editor.view.focus();
    };

    render();

    // Expose startEdit so MathTrigger.openEditMode can call it directly
    (dom as any)._mathStartEdit = startEdit;

    // ── Event Handlers ──
    // DO NOT use mousedown handlers on dom — they break ProseMirror selection/drag.
    // Instead, use ProseMirror's own selectNode/deselectNode callbacks for
    // detecting when user clicks on this atom node.

    // Double-click on the node opens edit mode
    dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startEdit();
    });

    // Prevent edit container events from reaching ProseMirror
    editContainer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    inputEl.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      e.stopPropagation();

      if (autocomplete.handleKeyDown(ke)) return;

      if (ke.key === 'Enter' && (!isBlock || ke.ctrlKey || ke.metaKey)) {
        e.preventDefault();
        finishEdit(true);
      }
      if (ke.key === 'Escape') {
        e.preventDefault();
        finishEdit(false);
      }
      if (ke.key === 'Tab' && !autocomplete.isActive()) {
        e.preventDefault();
        finishEdit(true);
      }
    });

    inputEl.addEventListener('blur', () => {
      if (finishScheduled) return;
      finishScheduled = true;
      setTimeout(() => {
        if (editing && !autocomplete.isActive()) {
          mathLog('blur: auto-finish');
          finishEdit(true);
        }
        finishScheduled = false;
      }, 150);
    });

    inputEl.addEventListener('input', () => {
      const val = (inputEl as HTMLInputElement).value.trim();
      if (val) {
        try {
          katex.render(val, display, { throwOnError: false, displayMode: isBlock });
          if (isBlock && previewContainer) {
            katex.render(val, previewContainer, { throwOnError: false, displayMode: true });
          }
        } catch { /* ignore */ }
      }
    });

    return {
      dom,
      // selectNode: Called by ProseMirror when this atom node is selected (single click).
      // We add a visual indicator. Double-click opens edit mode.
      selectNode() {
        dom.classList.add('ProseMirror-selectednode');
      },
      deselectNode() {
        dom.classList.remove('ProseMirror-selectednode');
      },
      stopEvent(event: Event) {
        // When editing, capture all events targeting the edit container
        if (editing && editContainer.contains(event.target as globalThis.Node)) {
          return true;
        }
        // When editing, also capture keyboard events (they should go to our input)
        if (editing && (event.type === 'keydown' || event.type === 'keypress' || event.type === 'input')) {
          return true;
        }
        return false;
      },
      ignoreMutation() { return true; },
      update(updatedNode: any) {
        if (updatedNode.type.name !== (isBlock ? 'mathBlock' : 'mathInline')) return false;
        formula = updatedNode.attrs.formula;
        if (!editing) render();
        return true;
      },
      destroy() {
        autocomplete.destroy();
      },
    };
  };
}

// ═══════════════════════════════════════
// Inline Math: $formula$
// ═══════════════════════════════════════
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { formula: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-math-inline]', getAttrs: el => ({ formula: (el as HTMLElement).getAttribute('data-formula') || '' }) }];
  },

  renderHTML({ node }) {
    return ['span', mergeAttributes({ 'data-math-inline': '', 'data-formula': node.attrs.formula, class: 'math-node math-inline-node' }), `$${node.attrs.formula}$`];
  },

  addNodeView() { return createMathNodeView(false); },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const f = node.attrs.formula;
          if (f === null || f === undefined || f === '') return;
          state.write(`$${f}$`);
        },
        parse: {},
      },
    };
  },

  // WORKAROUND: tiptap-markdown does NOT reliably call addStorage().markdown.serialize
  // for inline atom nodes. Two-layer defense:
  // 1. Patch serializer.serialize() to inject our node handler
  // 2. Patch getMarkdown() as safety net to replace any remaining <mathInline> tags
  onCreate() {
    const editor = this.editor;
    const mdStorage = (editor.storage as any).markdown;
    if (!mdStorage || mdStorage._mathPatched) return;

    // Layer 1: Patch serializer
    if (mdStorage.serializer) {
      const serializer = mdStorage.serializer;
      const origSerialize = serializer.serialize.bind(serializer);

      const mathInlineSerializer = (state: any, node: any) => {
        const f = node.attrs.formula;
        if (f === null || f === undefined || f === '') return;
        state.write(`$${f}$`);
      };

      const mathBlockSerializer = (state: any, node: any) => {
        const f = node.attrs.formula;
        if (f === null || f === undefined || f === '') return;
        state.write(`$$${f}$$`);
        state.closeBlock(node);
      };

      serializer.serialize = (content: any) => {
        const nodes = serializer.nodes;
        nodes.mathInline = mathInlineSerializer;
        nodes.mathBlock = mathBlockSerializer;
        const proto = Object.getPrototypeOf(serializer);
        Object.defineProperty(serializer, 'nodes', { value: nodes, configurable: true });
        const result = origSerialize(content);
        delete (serializer as any).nodes;
        return result;
      };
    }

    // Layer 2: Recover formula from HTML-fallback tags in getMarkdown output.
    // When math nodes are inside HTML blocks (<p style="...">), the serializer
    // patch doesn't apply — they get serialized as HTML with data-formula attribute.
    const origGetMarkdown = mdStorage.getMarkdown;
    mdStorage.getMarkdown = () => {
      let md: string = origGetMarkdown();

      // Recover math from ANY HTML tag containing data-formula attribute.
      // Atom nodes produce empty tags: <span data-math-inline data-formula="..."></span>
      // or self-closing: <span ... />
      // Match ANY tag with data-formula, extract the formula, convert to $..$ or $$..$$
      md = md.replace(/<[^>]*data-math-inline[^>]*data-formula="([^"]*)"[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
        (_m: string, f: string) => f ? `$${f}$` : '');
      md = md.replace(/<[^>]*data-formula="([^"]*)"[^>]*data-math-inline[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
        (_m: string, f: string) => f ? `$${f}$` : '');

      md = md.replace(/<[^>]*data-math-block[^>]*data-formula="([^"]*)"[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
        (_m: string, f: string) => f ? `$$${f}$$\n` : '');
      md = md.replace(/<[^>]*data-formula="([^"]*)"[^>]*data-math-block[^>]*(?:\/>|>[^<]*<\/[^>]+>)/g,
        (_m: string, f: string) => f ? `$$${f}$$\n` : '');

      // Remove bare <mathInline>/<mathBlock> (no formula to recover)
      md = md.replace(/<mathInline[^>]*>([^<]*)<\/mathInline>/g, '');
      md = md.replace(/<mathBlock[^>]*>([^<]*)<\/mathBlock>/g, '');

      return md;
    };

    mdStorage._mathPatched = true;
    mathLog('Math: patched serializer + getMarkdown safety net');
  },
});

// ═══════════════════════════════════════
// Block Math: $$formula$$
// ═══════════════════════════════════════
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { formula: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-math-block]', getAttrs: el => ({ formula: (el as HTMLElement).getAttribute('data-formula') || '' }) }];
  },

  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-math-block': '', 'data-formula': node.attrs.formula, class: 'math-node math-block-node' }), `$$${node.attrs.formula}$$`];
  },

  addNodeView() { return createMathNodeView(true); },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const f = node.attrs.formula;
          if (f === null || f === undefined || f === '') return;
          state.write(`$$${f}$$`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },

  // Math serializer patching is handled by MathInline.onCreate (both types)
});

// ═══════════════════════════════════════
// $ Trigger
//
// Converts typed $ into math nodes.
// Handles Korean/CJK IME by tracking composition state.
// ═══════════════════════════════════════
const MATH_TRIGGER_KEY = new PluginKey('mathTrigger');

export const MathTrigger = Extension.create({
  name: 'mathTrigger',

  addProseMirrorPlugins() {
    let pendingDollar: { pos: number; timeout: ReturnType<typeof setTimeout> } | null = null;
    let composing = false;

    const clearPending = () => {
      if (pendingDollar) {
        clearTimeout(pendingDollar.timeout);
        pendingDollar = null;
      }
    };

    /**
     * Opens edit mode on the math node at `pos` by dispatching a
     * dblclick event on its DOM element.
     */
    const openEditMode = (view: any, pos: number) => {
      setTimeout(() => {
        try {
          const n = view.state.doc.nodeAt(pos);
          if (!n || (n.type.name !== 'mathInline' && n.type.name !== 'mathBlock')) return;

          const domNode = view.nodeDOM(pos) as HTMLElement | null;
          if (!domNode) return;

          // Call startEdit directly via DOM reference (same function as dblclick handler)
          const startEditFn = (domNode as any)._mathStartEdit;
          if (startEditFn) {
            mathLog('openEditMode: direct startEdit at pos', pos);
            startEditFn();
          } else {
            mathLog('openEditMode: fallback dblclick at pos', pos);
            domNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }
        } catch (e) {
          mathLog('openEditMode: failed', e);
        }
      }, 50);
    };

    const insertMathInline = (view: any, dollarPos: number) => {
      const { state } = view;

      mathLog('insertMathInline:', { dollarPos, docSize: state.doc.content.size, composing });

      if (composing) {
        mathLog('insertMathInline: BLOCKED — composing');
        return;
      }

      if (dollarPos < 0 || dollarPos >= state.doc.content.size) return;

      const textAt = state.doc.textBetween(dollarPos, Math.min(dollarPos + 1, state.doc.content.size));
      if (textAt !== '$') {
        mathLog('insertMathInline: no $ at pos, found:', JSON.stringify(textAt));
        return;
      }

      const mathInline = state.schema.nodes.mathInline?.create({ formula: '' });
      if (!mathInline) return;

      const tr = state.tr.delete(dollarPos, dollarPos + 1).insert(dollarPos, mathInline);
      try {
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(dollarPos + 1, tr.doc.content.size)), 1));
      } catch { /* ignore */ }

      view.dispatch(tr);
      openEditMode(view, dollarPos);
    };

    const insertMathBlock = (view: any, firstDollarPos: number) => {
      const { state } = view;

      if (composing) return;
      if (firstDollarPos < 0 || firstDollarPos >= state.doc.content.size) return;

      const $pos = state.doc.resolve(firstDollarPos);
      const mathBlock = state.schema.nodes.mathBlock?.create({ formula: '' });
      if (!mathBlock) return;

      try {
        const tr = state.tr.replaceWith($pos.before(), $pos.after(), mathBlock);
        view.dispatch(tr);
      } catch {
        insertMathInline(view, firstDollarPos);
      }
    };

    return [
      new Plugin({
        key: MATH_TRIGGER_KEY,

        view(editorView) {
          const editorDom = editorView.dom;

          const onCompositionStart = () => {
            composing = true;
            mathLog('compositionStart');
            if (pendingDollar) {
              clearTimeout(pendingDollar.timeout);
            }
          };

          const onCompositionEnd = () => {
            composing = false;
            mathLog('compositionEnd');
            if (pendingDollar) {
              const pos = pendingDollar.pos;
              pendingDollar = null;
              // Delay to let composition result settle in ProseMirror
              setTimeout(() => insertMathInline(editorView, pos), 100);
            }
          };

          editorDom.addEventListener('compositionstart', onCompositionStart);
          editorDom.addEventListener('compositionend', onCompositionEnd);

          return {
            destroy() {
              editorDom.removeEventListener('compositionstart', onCompositionStart);
              editorDom.removeEventListener('compositionend', onCompositionEnd);
              clearPending();
            },
          };
        },

        props: {
          handleTextInput(view, from, _to, text) {
            if (composing) return false;

            if (text !== '$') {
              if (pendingDollar) {
                const dollarPos = pendingDollar.pos;
                clearPending();

                mathLog('trigger: non-$ while pending', { char: text, from, dollarPos });
                const adjustedPos = from <= dollarPos ? dollarPos + text.length : dollarPos;
                setTimeout(() => insertMathInline(view, adjustedPos), 0);
              }
              return false;
            }

            // text === '$'
            if (pendingDollar) {
              const firstPos = pendingDollar.pos;
              clearPending();
              setTimeout(() => insertMathBlock(view, firstPos), 0);
              return false;
            }

            // First $
            mathLog('trigger: first $ at', from);
            pendingDollar = {
              pos: from,
              timeout: setTimeout(() => {
                if (pendingDollar) {
                  const pos = pendingDollar.pos;
                  pendingDollar = null;
                  insertMathInline(view, pos);
                }
              }, 300),
            };
            return false;
          },
        },
      }),
    ];
  },
});
