import { useState, useRef, useEffect } from 'react';
import {
  DEFAULT_SHORTCUTS,
  KEYBOARD_ROWS,
  getActiveKeys,
  getKeyBindings,
  getShortcutLabel,
  getCategoryLabel,
  parseShortcut,
  type ShortcutBinding,
} from '../../utils/shortcuts';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { t } from '../../utils/i18n';

interface KeyboardShortcutsProps {
  customShortcuts: ShortcutBinding[];
  onUpdateShortcuts: (shortcuts: ShortcutBinding[]) => void;
}

function KeyboardShortcuts({ customShortcuts, onUpdateShortcuts }: KeyboardShortcutsProps) {
  const language = useSettingsStore(s => s.language);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKeys, setEditingKeys] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Cancel editing when clicking outside the input
  useEffect(() => {
    if (!editingId) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (editInputRef.current && !editInputRef.current.contains(e.target as Node)) {
        setEditingId(null);
      }
    };

    // Delay adding listener to avoid immediate trigger
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [editingId]);

  // Merge defaults with custom overrides
  const mergedShortcuts = DEFAULT_SHORTCUTS.map(def => {
    const custom = customShortcuts.find(c => c.id === def.id);
    return custom ? { ...def, customKeys: custom.customKeys } : def;
  });

  const keyBindings = getKeyBindings(mergedShortcuts);

  const filteredShortcuts = selectedCategory === 'all'
    ? mergedShortcuts
    : mergedShortcuts.filter(s => s.category === selectedCategory);

  const handleStartEdit = (binding: ShortcutBinding) => {
    setEditingId(binding.id);
    setEditingKeys(getActiveKeys(binding));
  };

  const handleKeyCapture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      setEditingId(null);
      return;
    }
    if (e.key === 'Enter') {
      // Save
      if (editingId && editingKeys) {
        const updated = [...customShortcuts.filter(c => c.id !== editingId)];
        const def = DEFAULT_SHORTCUTS.find(d => d.id === editingId);
        if (def && editingKeys !== def.defaultKeys) {
          updated.push({ ...def, customKeys: editingKeys });
        }
        onUpdateShortcuts(updated);
      }
      setEditingId(null);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      parts.push(key);
    }

    if (parts.length > 0) {
      setEditingKeys(parts.join('+'));
    }
  };

  const handleReset = (bindingId: string) => {
    const updated = customShortcuts.filter(c => c.id !== bindingId);
    onUpdateShortcuts(updated);
  };

  const getKeyLabel = (key: string): string => {
    if (key === '`') return '`';
    if (key === '-') return '-';
    if (key === '=') return '=';
    if (key === '[') return '[';
    if (key === ']') return ']';
    if (key === '\\') return '\\';
    if (key === ';') return ';';
    if (key === "'") return "'";
    if (key === ',') return ',';
    if (key === '.') return '.';
    if (key === '/') return '/';
    return key;
  };

  return (
    <div className="keyboard-shortcuts">
      {/* Keyboard Layout */}
      <div className="keyboard-layout">
        {KEYBOARD_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="keyboard-row">
            {row.map(key => {
              const bindings = keyBindings.get(key.toUpperCase()) || [];
              const hasBinding = bindings.length > 0;
              return (
                <div
                  key={key}
                  className={`keyboard-key ${hasBinding ? 'has-binding' : ''}`}
                  title={hasBinding ? bindings.map(b => `${getShortcutLabel(b, language)}: ${getActiveKeys(b)}`).join('\n') : undefined}
                >
                  <span className="keyboard-key-label">{getKeyLabel(key)}</span>
                  {hasBinding && <span className="keyboard-key-dot" />}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Category filter */}
      <div className="shortcuts-filter">
        <button
          className={`shortcuts-filter-btn ${selectedCategory === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedCategory('all')}
        >
          {t('shortcutsAll', language)}
        </button>
        {['text', 'heading', 'list', 'block', 'system', 'navigation'].map(key => (
          <button
            key={key}
            className={`shortcuts-filter-btn ${selectedCategory === key ? 'active' : ''}`}
            onClick={() => setSelectedCategory(key)}
          >
            {getCategoryLabel(key, language)}
          </button>
        ))}
      </div>

      {/* Shortcuts table */}
      <div className="shortcuts-table">
        {filteredShortcuts.map(binding => {
          const isEditing = editingId === binding.id;
          const isCustomized = !!binding.customKeys && binding.customKeys !== binding.defaultKeys;
          const parsed = parseShortcut(getActiveKeys(binding));
          return (
            <div key={binding.id} className={`shortcuts-row ${isCustomized ? 'customized' : ''}`}>
              <span className="shortcuts-label">{getShortcutLabel(binding, language)}</span>
              <div className="shortcuts-keys">
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    className="shortcuts-edit-input"
                    value={editingKeys}
                    onKeyDown={handleKeyCapture}
                    autoFocus
                    readOnly
                    placeholder={t('shortcutsInputPlaceholder', language)}
                  />
                ) : (
                  <button className="shortcuts-key-btn" onClick={() => handleStartEdit(binding)}>
                    {parsed.ctrl && <span className="shortcut-mod">Ctrl</span>}
                    {parsed.shift && <span className="shortcut-mod">Shift</span>}
                    {parsed.alt && <span className="shortcut-mod">Alt</span>}
                    <span className="shortcut-key">{parsed.key}</span>
                  </button>
                )}
                {isCustomized && !isEditing && (
                  <button className="shortcuts-reset-btn" onClick={() => handleReset(binding.id)} title={t('shortcutsReset', language)}>
                    ↺
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default KeyboardShortcuts;
