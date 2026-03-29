import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { all, createLowlight } from 'lowlight';

// Create lowlight instance with all languages (standard TipTap pattern)
const lowlight = createLowlight(all);

// Export for potential use in custom components
export { lowlight };

// Available languages for future dropdown UI
export const SUPPORTED_LANGUAGES = [
  { value: '', label: 'Auto-detect' },
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

/**
 * CodeBlock extension with lowlight syntax highlighting.
 * Uses the standard TipTap CodeBlockLowlight configuration.
 */
const CodeBlockAutoLanguage = CodeBlockLowlight.configure({
  lowlight,
});

export default CodeBlockAutoLanguage;
