/**
 * Categorize attachment files by extension for styling/icon differentiation.
 */

const CATEGORY_MAP: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif'],
  document: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'pages', 'key', 'hwp', 'hwpx', 'rtf', 'odt', 'odp'],
  data: ['xlsx', 'xls', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml'],
  code: ['py', 'js', 'ts', 'jsx', 'tsx', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'sql', 'lua', 'r', 'swift', 'kt', 'scala', 'html', 'css'],
  contact: ['vcf', 'vcard'],
  media: ['mp3', 'mp4', 'wav', 'ogg', 'flac', 'avi', 'mkv', 'mov', 'webm', 'aac', 'm4a', 'wma'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst'],
  markdown: ['md'],
};

// Build reverse lookup for O(1) access
const EXT_TO_CATEGORY = new Map<string, string>();
for (const [category, extensions] of Object.entries(CATEGORY_MAP)) {
  for (const ext of extensions) {
    EXT_TO_CATEGORY.set(ext, category);
  }
}

export function getAttachmentCategory(fileName: string): string {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return EXT_TO_CATEGORY.get(ext) || 'other';
}
