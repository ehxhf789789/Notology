/**
 * MathAutocompleteController
 *
 * Manages LaTeX command autocomplete inside math edit fields.
 * Attaches to an input/textarea element and shows a suggestion dropdown
 * when the user types a backslash (\) followed by characters.
 *
 * Uses pure DOM (no React) since it lives inside a ProseMirror NodeView.
 */
import katex from 'katex';
import { searchLatexCommands, CATEGORY_LABELS, type LatexCommand } from './mathLatexDictionary';

export class MathAutocompleteController {
  private inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private popup: HTMLDivElement | null = null;
  private items: LatexCommand[] = [];
  private selectedIndex = 0;
  private active = false;
  private query = '';
  private triggerPos = -1; // cursor position of the \

  private boundOnInput = () => this.onInput();

  attach(inputEl: HTMLInputElement | HTMLTextAreaElement) {
    this.inputEl = inputEl;
    inputEl.addEventListener('input', this.boundOnInput);
  }

  detach() {
    if (this.inputEl) {
      this.inputEl.removeEventListener('input', this.boundOnInput);
      this.inputEl = null;
    }
    this.hidePopup();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Handle keydown events. Returns true if the event was consumed.
   * Must be called from the math node view's keydown handler.
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.active) return false;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex + this.items.length - 1) % this.items.length;
        this.updateSelection();
        return true;

      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
        this.updateSelection();
        return true;

      case 'Enter':
      case 'Tab':
        if (this.items.length > 0) {
          e.preventDefault();
          this.selectItem(this.selectedIndex);
          return true;
        }
        return false;

      case 'Escape':
        e.preventDefault();
        this.hidePopup();
        return true;

      default:
        return false;
    }
  }

  // ── Private ──

  private onInput() {
    if (!this.inputEl) return;

    const value = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? value.length;

    // Scan backward from cursor for \
    let backslashPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === '\\') {
        backslashPos = i;
        break;
      }
      // Stop scanning at spaces, braces, or other special chars
      if (ch === ' ' || ch === '{' || ch === '}' || ch === '$') break;
    }

    if (backslashPos === -1) {
      this.hidePopup();
      return;
    }

    // Don't trigger if this is a \\ (line break in matrix/aligned)
    // Check if there's another \ right before this one
    if (backslashPos > 0 && value[backslashPos - 1] === '\\') {
      this.hidePopup();
      return;
    }

    this.query = value.substring(backslashPos + 1, cursorPos);
    this.triggerPos = backslashPos;

    // Search with the query (without the \)
    this.items = searchLatexCommands(this.query, 10);

    if (this.items.length === 0) {
      this.hidePopup();
      return;
    }

    this.selectedIndex = 0;
    this.active = true;
    this.showPopup();
  }

  private showPopup() {
    if (!this.inputEl) return;

    if (!this.popup) {
      this.popup = document.createElement('div');
      this.popup.className = 'math-autocomplete-popup';
      // Prevent blur on input when clicking popup background
      this.popup.addEventListener('mousedown', (e) => e.preventDefault());
      document.body.appendChild(this.popup);
    }

    // Position relative to input element
    const rect = this.inputEl.getBoundingClientRect();
    this.popup.style.left = `${rect.left}px`;
    this.popup.style.top = `${rect.bottom + 4}px`;
    this.popup.style.minWidth = `${Math.max(rect.width, 280)}px`;
    this.popup.style.display = 'block';

    this.renderItems();
  }

  private hidePopup() {
    this.active = false;
    if (this.popup) {
      this.popup.style.display = 'none';
    }
  }

  private renderItems() {
    if (!this.popup) return;

    this.popup.innerHTML = '';

    let lastCategory = '';
    this.items.forEach((item, index) => {
      // Category header
      if (item.category !== lastCategory) {
        lastCategory = item.category;
        const header = document.createElement('div');
        header.className = 'math-autocomplete-category';
        header.textContent = CATEGORY_LABELS[item.category] || item.category;
        this.popup!.appendChild(header);
      }

      const row = document.createElement('div');
      row.className = `math-autocomplete-item${index === this.selectedIndex ? ' selected' : ''}`;
      row.dataset.index = String(index);

      // Command name
      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'math-autocomplete-cmd';
      cmdSpan.textContent = item.command;
      row.appendChild(cmdSpan);

      // Label
      const labelSpan = document.createElement('span');
      labelSpan.className = 'math-autocomplete-label';
      labelSpan.textContent = item.label;
      row.appendChild(labelSpan);

      // KaTeX preview
      const previewSpan = document.createElement('span');
      previewSpan.className = 'math-autocomplete-preview';
      try {
        katex.render(item.preview, previewSpan, { throwOnError: false, displayMode: false });
      } catch {
        previewSpan.textContent = item.preview;
      }
      row.appendChild(previewSpan);

      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Don't steal focus from input
        this.selectItem(index);
      });

      row.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });

      this.popup!.appendChild(row);
    });
  }

  private updateSelection() {
    if (!this.popup) return;
    const items = this.popup.querySelectorAll('.math-autocomplete-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === this.selectedIndex);
    });

    // Scroll selected item into view
    const selected = this.popup.querySelector('.math-autocomplete-item.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  private selectItem(index: number) {
    const item = this.items[index];
    if (!item || !this.inputEl) return;

    const value = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? value.length;

    // Replace \query with the snippet
    const before = value.substring(0, this.triggerPos);
    const after = value.substring(cursorPos);
    const snippet = item.snippet;

    // Find first tab stop ($1)
    const tabStop1 = snippet.indexOf('$1');

    if (tabStop1 === -1) {
      // No tab stops — just insert
      this.inputEl.value = before + snippet + after;
      const newPos = before.length + snippet.length;
      this.inputEl.setSelectionRange(newPos, newPos);
    } else {
      // Replace $1 with empty, position cursor there
      const cleaned = snippet.replace(/\$\d/g, '');
      this.inputEl.value = before + cleaned + after;
      // Position cursor at where $1 was
      const newPos = before.length + tabStop1;
      this.inputEl.setSelectionRange(newPos, newPos);
    }

    // Trigger input event so live preview updates
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    this.hidePopup();
    this.inputEl.focus();
  }

  /** Call this on destroy to clean up DOM */
  destroy() {
    this.detach();
    if (this.popup && this.popup.parentNode) {
      this.popup.parentNode.removeChild(this.popup);
      this.popup = null;
    }
  }
}
