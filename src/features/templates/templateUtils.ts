import { fileCommands } from '../../core/services/tauriCommands';
import { join } from '@tauri-apps/api/path';
import type { Frontmatter, NoteType } from '../../core/types/frontmatter';
import { generateNoteId, createDefaultFrontmatter } from '../../core/utils/frontmatterUtils';
import type { LanguageSetting } from '../../core/utils/i18n';
import { t } from '../../core/utils/i18n';

interface TemplateConfig {
  templates: Record<NoteType, any>;
}

let cachedTemplates: TemplateConfig | null = null;

/**
 * Load note templates from .notology/templates/note-template.yaml
 */
export async function loadTemplates(vaultPath: string): Promise<TemplateConfig> {
  if (cachedTemplates) {
    return cachedTemplates;
  }

  try {
    const templatePath = await join(vaultPath, '.notology', 'templates', 'note-template.yaml');
    const yamlContent = await fileCommands.readTextFile(templatePath);

    // Simple YAML parsing for templates (could use a proper YAML parser)
    // For now, we'll use the createDefaultFrontmatter as fallback
    cachedTemplates = { templates: {} as Record<NoteType, any> };
    return cachedTemplates;
  } catch (error) {
    console.error('Failed to load templates:', error);
    return { templates: {} as Record<NoteType, any> };
  }
}

/**
 * Clear cached templates
 */
export function clearTemplateCache() {
  cachedTemplates = null;
}

/**
 * Apply template variables to a template string
 */
export function applyTemplateVariables(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * Create frontmatter from template
 */
export function createFromTemplate(
  noteType: NoteType,
  title: string,
  customVariables?: Record<string, string>
): Frontmatter {
  const now = new Date().toISOString();
  const id = generateNoteId();

  const variables = {
    id,
    title,
    created: now,
    modified: now,
    ...customVariables,
  };

  // For now, use the default frontmatter creator
  // In future, we can load from template files
  const frontmatter = createDefaultFrontmatter(noteType, title);

  // Apply type-specific defaults (only metadata, NO hardcoded tags)
  switch (noteType) {
    case 'MTG':
      frontmatter.date = customVariables?.date || now;
      if (customVariables?.time) {
        frontmatter.time = customVariables.time;
      }
      if (customVariables?.participants) {
        frontmatter.participants = customVariables.participants.split(',').map(p => p.trim()).filter(Boolean);
      } else {
        frontmatter.participants = [];
      }
      break;

    case 'PAPER':
      if (customVariables?.authors) {
        frontmatter.authors = customVariables.authors.split(',').map(a => a.trim()).filter(Boolean);
      } else {
        frontmatter.authors = [];
      }
      frontmatter.year = customVariables?.year ? parseInt(customVariables.year) : undefined;
      frontmatter.venue = customVariables?.venue || undefined;
      frontmatter.doi = customVariables?.doi || undefined;
      frontmatter.url = customVariables?.url || undefined;
      frontmatter.state.maturity = 2;
      break;

    case 'THEO':
      // No type-specific defaults for THEO
      break;

    case 'LIT':
      if (customVariables?.authors) {
        frontmatter.authors = customVariables.authors.split(',').map(a => a.trim()).filter(Boolean);
      } else {
        frontmatter.authors = [];
      }
      frontmatter.year = customVariables?.year ? parseInt(customVariables.year) : undefined;
      frontmatter.publisher = customVariables?.publisher || undefined;
      frontmatter.source = customVariables?.source || undefined;
      frontmatter.url = customVariables?.url || undefined;
      frontmatter.state.maturity = 2;
      break;

    case 'EVENT':
      frontmatter.date = customVariables?.date || undefined;
      frontmatter.location = customVariables?.location || undefined;
      frontmatter.organizer = customVariables?.organizer || undefined;
      if (customVariables?.participants) {
        frontmatter.participants = customVariables.participants.split(',').map(p => p.trim()).filter(Boolean);
      } else {
        frontmatter.participants = [];
      }
      break;

    case 'CONTACT':
      frontmatter.state.workflow = 'final';
      frontmatter.state.confidence = 'verified';
      frontmatter.state.maturity = 3;
      frontmatter.email = customVariables?.email || '';
      frontmatter.phone = customVariables?.phone || '';
      frontmatter.organization = customVariables?.organization || customVariables?.company || '';
      frontmatter.role = customVariables?.role || customVariables?.position || '';
      frontmatter.location = customVariables?.location || '';
      // Add alias for contact lookup
      if (customVariables?.name || title) {
        const contactName = customVariables?.name || title;
        frontmatter.aliases = [contactName];
      }
      break;

    case 'CONTAINER':
      frontmatter.state.workflow = 'final';
      frontmatter.state.confidence = 'verified';
      frontmatter.state.maturity = 3;
      break;

    case 'SKETCH':
      frontmatter.state.workflow = 'draft';
      frontmatter.state.confidence = 'unverified';
      frontmatter.state.maturity = 1;
      (frontmatter as any).sketch = true;  // Enable sketch mode for SKETCH notes
      // NO hardcoded tags - use template tagCategories instead
      break;
  }

  return frontmatter;
}

/**
 * Get body template for note type (language-aware)
 * Format: # Heading sections separated by *** horizontal rules
 */
export function getBodyTemplate(noteType: NoteType, language: LanguageSetting = 'ko'): string {
  const T = (key: string) => t(key, language);

  switch (noteType) {
    case 'MTG':
      return `# ${T('tmplMtgInfo')}
- **${T('tmplDate')}**: {{date}}
- **${T('tmplTime')}**: {{time}}
- **${T('tmplParticipants')}**: {{participants}}

***
# ${T('tmplAgenda')}

***
# ${T('tmplDiscussion')}

***
# ${T('tmplDecisions')}

***
`;

    case 'PAPER':
      return `# ${T('tmplPaperInfo')}
- **${T('tmplAuthors')}**: {{authors}}
- **${T('tmplYear')}**: {{year}}
- **${T('tmplVenue')}**: {{venue}}
- **${T('tmplDoi')}**: {{doi}}

***
# ${T('tmplSummary')}

***
# ${T('tmplContributions')}

***
# ${T('tmplMethodology')}

***
# ${T('tmplResults')}

***
`;

    case 'THEO':
      return `# ${T('tmplDefinition')}

***
# ${T('tmplBackground')}

***
# ${T('tmplKeyConcepts')}

***
# ${T('tmplApplications')}

***
# ${T('tmplRelatedTheories')}

***
`;

    case 'LIT':
      return `# ${T('tmplLitInfo')}
- **${T('tmplAuthors')}**: {{authors}}
- **${T('tmplYear')}**: {{year}}
- **${T('tmplPublisher')}**: {{publisher}}
- **${T('tmplSource')}**: {{source}}
- **${T('tmplUrl')}**: {{url}}

***
# ${T('tmplSummary')}

***
# ${T('tmplKeyContent')}

***
`;

    case 'EVENT':
      return `# ${T('tmplEventInfo')}
- **${T('tmplDate')}**: {{date}}
- **${T('tmplLocation')}**: {{location}}
- **${T('tmplOrganizer')}**: {{organizer}}
- **${T('tmplEventParticipants')}**: {{participants}}

***
# ${T('tmplOverview')}

***
# ${T('tmplSchedule')}

***
`;

    case 'CONTACT':
      return `# ${T('tmplContactInfo')}
- **${T('tmplEmail')}**: {{email}}
- **${T('tmplPhone')}**: {{phone}}
- **${T('tmplOrganization')}**: {{organization}}
- **${T('tmplRole')}**: {{role}}

***
# ${T('tmplHistory')}
-

***
# ${T('tmplRelatedNotes')}
-

***
`;

    case 'CONTAINER':
      return `# ${T('tmplOverview')}

***
# ${T('tmplSubItems')}

***
`;

    case 'SKETCH':
      return ''; // Canvas notes don't need a markdown body template

    case 'SEM':
      return `# ${T('tmplOverview')}

***
# ${T('tmplContent')}

***
# ${T('tmplKeyPoints')}

***
`;

    case 'OFA':
      return `# ${T('tmplOverview')}

***
# ${T('tmplContent')}

***
# ${T('tmplDecisions')}

***
`;

    case 'DATA':
      return `# ${T('tmplOverview')}

***
# ${T('tmplDataDescription')}

***
`;

    case 'SETUP':
      return `# ${T('tmplOverview')}

***
# ${T('tmplContext')}

***
`;

    case 'NOTE':
    default:
      return `# ${T('tmplOverview')}

***
# ${T('tmplContent')}

***
`;
  }
}
