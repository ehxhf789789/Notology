import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { InputRule } from '@tiptap/core';
import { preloadHoverContent } from '../../../features/hover-windows/stores/hoverStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../utils/i18n';
import { getAttachmentCategory } from '../../../features/suggestions/attachmentCategory';

export interface WikiLinkOptions {
  onClickLink: (fileName: string) => void;
  onContextMenu: (fileName: string, position: { x: number; y: number }, deleteCallback?: () => void) => void;
  resolveLink: (fileName: string) => boolean;
  getNoteType?: (fileName: string) => string | null;
  onEditorContextMenu?: (position: { x: number; y: number }) => void;
  // Getter function for notePath - allows dynamic updates without extension recreation
  getNotePath?: () => string;
  // Check if a file is an attachment (exists in current note's _att folder)
  // This is needed to distinguish .md attachments from vault notes
  isAttachment?: (fileName: string) => boolean;
  // Resolve fileName to full file path (for preloading on hover)
  resolveFilePath?: (fileName: string) => string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiLink: {
      insertWikiLink: (fileName: string) => ReturnType;
    };
  }
}

// Non-greedy matching to support ] in filenames (e.g., [[디자인여백플러스] 파일.pdf]])
// Use Unicode flag for proper handling of Korean characters
const WIKI_LINK_REGEX = /\[\[(.+?)\]\]/gu;
const IMAGE_EMBED_REGEX = /!\[\[(.+?)\]\]/gu;

// Helper to parse wiki link content: "fileName" or "fileName|displayText"
function parseWikiLinkContent(content: string): { fileName: string; displayText: string } {
  const pipeIndex = content.indexOf('|');
  if (pipeIndex >= 0) {
    return {
      fileName: content.substring(0, pipeIndex),
      displayText: content.substring(pipeIndex + 1)
    };
  }
  return { fileName: content, displayText: content };
}

// Helper function to infer note type from filename
function inferNoteType(fileName: string): string {
  const prefixes = ['NOTE', 'MTG', 'ADM', 'SEM', 'TASK', 'CONTACT', 'SETUP', 'DATA', 'THEO', 'PAPER', 'SKETCH'];
  const fileNameUpper = fileName.toUpperCase();

  for (const prefix of prefixes) {
    if (fileNameUpper.startsWith(prefix + '-') || fileNameUpper === prefix) {
      return prefix.toLowerCase();
    }
  }
  return '';
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      onClickLink: () => {},
      onContextMenu: () => {},
      resolveLink: () => true,
      getNoteType: undefined,
      onEditorContextMenu: undefined,
      getNotePath: undefined,
      isAttachment: undefined,
      resolveFilePath: undefined,
    };
  },

  addAttributes() {
    return {
      fileName: {
        default: null,
      },
      // Display text for alias links like [[fileName|displayText]]
      displayText: {
        default: null,
      },
      // Store whether this is an attachment - persists even if file is deleted
      isAttachmentAttr: {
        default: false,
        parseHTML: (element: HTMLElement) => {
          // Check if the element has 'attachment' class
          return element.classList.contains('attachment');
        },
        renderHTML: (attributes: { isAttachmentAttr?: boolean }) => {
          // Don't render as HTML attribute - we use classes instead
          return {};
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (element: HTMLElement) => {
          return {
            fileName: element.getAttribute('data-wiki-link'),
            displayText: element.getAttribute('data-display-text'),
            isAttachmentAttr: element.classList.contains('attachment'),
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const fileName = node.attrs.fileName;
    const displayText = node.attrs.displayText || fileName;
    // Show underscores as spaces in display (only when no custom alias)
    const shownText = node.attrs.displayText ? displayText : fileName.replace(/_/g, ' ');
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(fileName);
    const isMarkdown = fileName.endsWith('.md');
    const storedIsAttachment = node.attrs.isAttachmentAttr;

    // Determine if this is an attachment:
    // 1. If file exists in _att folder (callback returns true) → attachment
    // 2. Else if previously marked as attachment (stored attr) → still attachment
    // 3. Else fall back to extension-based check
    const callbackResult = this.options.isAttachment ? this.options.isAttachment(fileName) : null;
    const isAttachment = callbackResult === true
      || (callbackResult === null && storedIsAttachment)
      || (callbackResult === null && !storedIsAttachment && hasExtension && !isMarkdown);

    const isResolved = this.options.resolveLink(fileName);

    // Use getNoteType callback if available, otherwise fall back to inferring from filename
    // If displayText starts with "@", treat as contact type (@ mentions are always contacts)
    const isMention = displayText && displayText.startsWith('@');
    const noteType = isAttachment ? '' :
      isMention ? 'contact' :
      (this.options.getNoteType ? (this.options.getNoteType(fileName) || '').toLowerCase() : inferNoteType(fileName));

    // Render shownText (underscores replaced with spaces for non-alias links)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': fileName,
        'data-display-text': displayText !== fileName ? displayText : null,
        class: `wiki-link-inline wiki-link-node ${isAttachment ? `attachment att-${getAttachmentCategory(fileName)}` : ''} ${noteType ? `note-type-${noteType}` : ''} ${isResolved ? '' : 'unresolved'}`,
      }),
      shownText,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const fileName = node.attrs.fileName || '';
          const displayText = node.attrs.displayText;
          if (displayText && displayText !== fileName) {
            state.write(`[[${fileName}|${displayText}]]`);
          } else {
            state.write(`[[${fileName}]]`);
          }
        },
        parse: {
          // Parsing is handled by the transform plugin (appendTransaction)
        },
      },
    };
  },

  addCommands() {
    const isAttachmentCallback = this.options.isAttachment;
    return {
      insertWikiLink: (fileName: string) => ({ commands }) => {
        const isAttachmentAttr = isAttachmentCallback ? isAttachmentCallback(fileName) : false;
        return commands.insertContent({
          type: this.name,
          attrs: { fileName, isAttachmentAttr },
        });
      },
    };
  },

  addInputRules() {
    const isAttachmentCallback = this.options.isAttachment;
    return [
      new InputRule({
        find: /\[\[(.+?)\]\]$/,
        handler: ({ state, range, match }) => {
          const { fileName, displayText } = parseWikiLinkContent(match[1]);
          const { tr } = state;
          // Check if this file is an attachment
          const isAttachmentAttr = isAttachmentCallback ? isAttachmentCallback(fileName) : false;

          tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ fileName, displayText: displayText !== fileName ? displayText : null, isAttachmentAttr })
          );
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const { onClickLink, onContextMenu, resolveLink, getNoteType, onEditorContextMenu, getNotePath, isAttachment: isAttachmentCallback, resolveFilePath } = this.options;
    const wikiLinkType = this.type;

    return [
      // Plugin to convert text [[...]] patterns to wiki link nodes
      new Plugin({
        key: new PluginKey('wikiLinkTransform'),
        appendTransaction: (transactions, _oldState, newState) => {
          // Only transform if there was a change
          if (!transactions.some(tr => tr.docChanged)) return null;

          const { tr, doc } = newState;
          let modified = false;

          // Find all text nodes with [[...]] patterns (but not ![[...]] for images)
          const nodesToReplace: Array<{ from: number; to: number; fileName: string; displayText: string | null }> = [];

          doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;

            const text = node.text;
            // Match [[...]] but not ![[...]]
            // Use Unicode flag for proper handling of Korean characters
            const regex = /(?<!!)\[\[(.+?)\]\]/gu;
            let match;

            while ((match = regex.exec(text)) !== null) {
              const from = pos + match.index;
              const to = from + match[0].length;
              const parsed = parseWikiLinkContent(match[1]);
              nodesToReplace.push({ from, to, fileName: parsed.fileName, displayText: parsed.displayText !== parsed.fileName ? parsed.displayText : null });
            }
          });

          // Replace text patterns with wiki link nodes (in reverse order to preserve positions)
          for (let i = nodesToReplace.length - 1; i >= 0; i--) {
            const { from, to, fileName, displayText } = nodesToReplace[i];
            // Check if this file is an attachment
            const isAttachmentAttr = isAttachmentCallback ? isAttachmentCallback(fileName) : false;
            const wikiLinkNode = wikiLinkType.create({ fileName, displayText, isAttachmentAttr });
            tr.replaceWith(from, to, wikiLinkNode);
            modified = true;
          }

          return modified ? tr : null;
        },
      }),
      new Plugin({
        key: new PluginKey('wikiLinkDecorations'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;

            doc.descendants((node, pos) => {
              // Handle wikiLink atom nodes - add decoration to update resolved/unresolved class dynamically
              if (node.type.name === 'wikiLink') {
                const fileName = node.attrs.fileName;
                const isResolved = resolveLink(fileName);
                const hasExtension = /\.[a-zA-Z0-9]+$/.test(fileName);
                const isMarkdown = fileName.endsWith('.md');
                const storedIsAttachment = node.attrs.isAttachmentAttr;

                // Determine if this is an attachment:
                // 1. If file exists in _att folder (callback returns true) → attachment
                // 2. Else if previously marked as attachment (stored attr) → still attachment
                // 3. Else fall back to extension-based check
                const callbackResult = isAttachmentCallback ? isAttachmentCallback(fileName) : null;
                const isAttachment = callbackResult === true
                  || (callbackResult === null && storedIsAttachment)
                  || (callbackResult === null && !storedIsAttachment && hasExtension && !isMarkdown);

                const noteType = isAttachment ? '' :
                  (getNoteType ? (getNoteType(fileName) || '').toLowerCase() : inferNoteType(fileName));

                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: `wiki-link-decoration ${isAttachment ? `attachment att-${getAttachmentCategory(fileName)}` : ''} ${noteType ? `note-type-${noteType}` : ''} ${isResolved ? 'resolved' : 'unresolved'}`,
                  })
                );
                return false; // Don't descend into atom node
              }

              if (!node.isText || !node.text) return;

              const text = node.text;
              const processedRanges: Array<{start: number, end: number}> = [];

              // First, handle image embeds ![[...]]
              // Reset lastIndex instead of creating new RegExp (performance)
              IMAGE_EMBED_REGEX.lastIndex = 0;
              let imageMatch;

              while ((imageMatch = IMAGE_EMBED_REGEX.exec(text)) !== null) {
                const start = pos + imageMatch.index;
                const end = start + imageMatch[0].length;
                const fileName = imageMatch[1];
                const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(fileName);

                // Call getNotePath() dynamically to get current note path
                const currentNotePath = getNotePath?.() || '';
                if (isImage && currentNotePath) {
                  processedRanges.push({ start: imageMatch.index, end: imageMatch.index + imageMatch[0].length });

                  // Capture fileName for delete callback
                  const capturedFileName = fileName;

                  decorations.push(
                    Decoration.widget(start, (view) => {
                      const wrapper = document.createElement('div');
                      wrapper.className = 'wiki-image-embed-wrapper';

                      // Image container for positioning delete button
                      const imageContainer = document.createElement('div');
                      imageContainer.className = 'wiki-image-embed-container';

                      const img = document.createElement('img');
                      const noteDir = currentNotePath.replace(/[^/\\]+$/, '');
                      const noteStem = currentNotePath.replace(/^.*[/\\]/, '').replace(/\.md$/, '');
                      const attachmentPath = `${noteDir}${noteStem}_att/${capturedFileName}`;

                      const win = window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (path: string) => string } } };
                      if (win.__TAURI__?.core?.convertFileSrc) {
                        img.src = win.__TAURI__.core.convertFileSrc(attachmentPath);
                      } else {
                        img.src = `asset://localhost/${attachmentPath}`;
                      }

                      img.className = 'wiki-image-embed';
                      img.alt = capturedFileName;
                      img.ondblclick = () => onClickLink(capturedFileName);

                      // Delete button
                      const deleteBtn = document.createElement('button');
                      deleteBtn.className = 'wiki-image-embed-delete';
                      deleteBtn.innerHTML = '×';
                      const lang = useSettingsStore.getState().language;
                      deleteBtn.title = t('deleteImageEmbed', lang);
                      deleteBtn.onmousedown = (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        // Find the ![[filename]] pattern in the current document
                        const { doc, tr } = view.state;
                        const searchPattern = `![[${capturedFileName}]]`;
                        let foundPos = -1;
                        let foundEnd = -1;

                        doc.descendants((node, nodePos) => {
                          if (foundPos >= 0) return false;
                          if (node.isText && node.text) {
                            const idx = node.text.indexOf(searchPattern);
                            if (idx >= 0) {
                              foundPos = nodePos + idx;
                              foundEnd = foundPos + searchPattern.length;
                              return false;
                            }
                          }
                        });

                        if (foundPos >= 0) {
                          view.dispatch(tr.delete(foundPos, foundEnd));
                        }
                      };

                      imageContainer.appendChild(img);
                      imageContainer.appendChild(deleteBtn);
                      wrapper.appendChild(imageContainer);
                      return wrapper;
                    }, { side: -1, key: `img-embed-${capturedFileName}` })
                  );
                  decorations.push(
                    Decoration.inline(start, end, {
                      class: 'wiki-image-embed-text',
                      style: 'display: none;',
                    })
                  );
                }
              }

              // Then handle regular wiki links [[...]]
              // Reset lastIndex instead of creating new RegExp (performance)
              WIKI_LINK_REGEX.lastIndex = 0;
              let match;

              while ((match = WIKI_LINK_REGEX.exec(text)) !== null) {
                const matchStart = match.index;
                const matchEnd = matchStart + match[0].length;

                // Skip if this overlaps with a processed range (image embed)
                const overlaps = processedRanges.some(range =>
                  (matchStart >= range.start && matchStart < range.end) ||
                  (matchEnd > range.start && matchEnd <= range.end)
                );
                if (overlaps) continue;

                const start = pos + matchStart;
                const end = pos + matchEnd;
                const parsed = parseWikiLinkContent(match[1]);
                const fileName = parsed.fileName;
                const displayText = parsed.displayText;
                const isResolved = resolveLink(fileName);

                // Check if this is an attachment
                const hasExtension = /\.[a-zA-Z0-9]+$/.test(fileName);
                const isMarkdown = fileName.endsWith('.md');

                // Use isAttachment callback if available, otherwise fall back to extension-based check
                const isAttachment = isAttachmentCallback
                  ? isAttachmentCallback(fileName)
                  : (hasExtension && !isMarkdown);

                // Use getNoteType callback if available, otherwise fall back to inferring from filename
                // If displayText starts with "@", treat as contact type (@ mentions are always contacts)
                const isMention = displayText && displayText.startsWith('@');
                const noteType = isAttachment ? '' :
                  isMention ? 'contact' :
                  (getNoteType ? (getNoteType(fileName) || '').toLowerCase() : inferNoteType(fileName));

                decorations.push(
                  Decoration.inline(start, end, {
                    class: `wiki-link-inline ${isAttachment ? `attachment att-${getAttachmentCategory(fileName)}` : ''} ${noteType ? `note-type-${noteType}` : ''} ${isResolved ? '' : 'unresolved'}`,
                    'data-wiki-link': fileName,
                  })
                );
              }
            });

            return DecorationSet.create(doc, decorations);
          },
          handleDoubleClick(_view, _pos, event) {
            if (event.button !== 0) return false;
            const target = event.target as HTMLElement;
            const wikiLink = target.closest('[data-wiki-link]');
            if (wikiLink) {
              const fileName = wikiLink.getAttribute('data-wiki-link');
              if (fileName) {
                onClickLink(fileName);
                return true;
              }
            }
            return false;
          },
          handleDOMEvents: {
            contextmenu(view, event) {
              const target = (event.target as HTMLElement).closest('[data-wiki-link]');
              if (target) {
                event.preventDefault();
                const fileName = target.getAttribute('data-wiki-link');
                if (fileName) {
                  // Find the position of this wiki link in the document
                  const pos = view.posAtDOM(target, 0);

                  // Create delete callback
                  const deleteCallback = () => {
                    const { state } = view;
                    const { doc, tr } = state;

                    // Find the decoration/node at this position
                    let foundPos = -1;
                    let foundEnd = -1;

                    doc.descendants((node, nodePos) => {
                      if (foundPos >= 0) return false;

                      // Check for atom node (wikiLink type)
                      if (node.type.name === 'wikiLink' && node.attrs.fileName === fileName) {
                        if (nodePos <= pos && pos <= nodePos + node.nodeSize) {
                          foundPos = nodePos;
                          foundEnd = nodePos + node.nodeSize;
                          return false;
                        }
                      }

                      // Check for text node with wiki link decoration
                      if (node.isText && node.text) {
                        const regex = /\[\[(.+?)\]\]/g;
                        let match;
                        while ((match = regex.exec(node.text)) !== null) {
                          const parsedMatch = parseWikiLinkContent(match[1]);
                          if (parsedMatch.fileName === fileName) {
                            const start = nodePos + match.index;
                            const end = start + match[0].length;
                            if (start <= pos && pos <= end) {
                              foundPos = start;
                              foundEnd = end;
                              return false;
                            }
                          }
                        }
                      }
                    });

                    if (foundPos >= 0) {
                      view.dispatch(tr.delete(foundPos, foundEnd));
                    }
                  };

                  onContextMenu(fileName, { x: event.clientX, y: event.clientY }, deleteCallback);
                  return true;
                }
              }
              // Not a wiki link - show editor formatting context menu
              if (onEditorContextMenu) {
                event.preventDefault();
                onEditorContextMenu({ x: event.clientX, y: event.clientY });
                return true;
              }
              return false;
            },
            // Preload content on hover for faster window opening
            mouseover(_view, event) {
              const target = (event.target as HTMLElement).closest('[data-wiki-link]');
              if (target) {
                const fileName = target.getAttribute('data-wiki-link');
                if (fileName && !target.classList.contains('attachment') && resolveFilePath) {
                  // Resolve fileName to full path and preload
                  const filePath = resolveFilePath(fileName);
                  if (filePath) {
                    preloadHoverContent(filePath);
                  }
                }
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

export default WikiLink;
