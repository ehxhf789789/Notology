import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';

// Supported languages for dropdown
const SUPPORTED_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'bash', label: 'Bash' },
  { value: 'sql', label: 'SQL' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'xml', label: 'XML' },
];

function CodeBlockView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = node.attrs.language;
  const collapsed = node.attrs.collapsed || false;
  const code = node.textContent;

  const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value || null;
    updateAttributes({ language: newLanguage });
  }, [updateAttributes]);

  const handleToggleCollapse = useCallback(() => {
    updateAttributes({ collapsed: !collapsed });
  }, [updateAttributes, collapsed]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [code]);

  // Reset copied state after 2 seconds
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  const handleDelete = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  // Insert a paragraph after this code block
  const handleInsertAfter = useCallback(() => {
    const pos = editor.state.selection.$anchor.end();
    editor.chain()
      .focus()
      .insertContentAt(pos + 1, { type: 'paragraph' })
      .run();
  }, [editor]);

  const displayLanguage = language || 'plaintext';
  // Count lines for collapsed preview
  const lineCount = code.split('\n').length;

  return (
    <NodeViewWrapper className={`code-block-wrapper ${collapsed ? 'collapsed' : ''}`}>
      <div className="code-block-header" contentEditable={false}>
        <button
          className="code-block-toggle-btn"
          onClick={handleToggleCollapse}
          title={collapsed ? 'Expand' : 'Collapse'}
          type="button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <select
          className="code-block-language-select"
          value={language || ''}
          onChange={handleLanguageChange}
        >
          <option value="">Auto-detect</option>
          {SUPPORTED_LANGUAGES.map(lang => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
        {collapsed && (
          <span className="code-block-collapsed-info">{lineCount} lines</span>
        )}
        <div className="code-block-actions">
          <button
            className="code-block-btn code-block-copy-btn"
            onClick={handleCopy}
            title="Copy code"
            type="button"
          >
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>
          <button
            className="code-block-btn code-block-add-btn"
            onClick={handleInsertAfter}
            title="Insert paragraph after"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button
            className="code-block-btn code-block-delete-btn"
            onClick={handleDelete}
            title="Delete code block"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
      {!collapsed && (
        <pre className={`hljs language-${displayLanguage}`}>
          <code>
            <NodeViewContent />
          </code>
        </pre>
      )}
    </NodeViewWrapper>
  );
}

export default CodeBlockView;
