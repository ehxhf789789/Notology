import { useFileTree, fileTreeActions, refreshActions, hoverActions, modalActions } from '../../stores/zustand';
import { useContainerConfigs } from '../../stores/zustand/vaultConfigStore';
import { useTemplateStore } from '../../stores/zustand/templateStore';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { createNoteWithTemplate } from '../../stores/appActions';
import { t, tf } from '../../utils/i18n';

// Templates that have their own input modals (skip TitleInputModal)
const SPECIAL_TEMPLATE_IDS = ['note-contact', 'note-mtg', 'note-paper', 'note-lit', 'note-event'];

function RibbonBar() {
  const fileTree = useFileTree();
  const containerConfigs = useContainerConfigs();
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const language = useSettingsStore(s => s.language);

  // Get storage containers
  const containers = fileTree.filter(node => node.is_dir);
  const storageContainers = containers.filter(
    node => containerConfigs[node.path]?.type === 'storage'
  );

  if (storageContainers.length === 0) return null;

  const handleRibbonClick = (containerPath: string) => {
    const config = containerConfigs[containerPath];
    if (!config?.assignedTemplateId) return;

    const templateId = config.assignedTemplateId;
    const templateInfo = getTemplateInfo(templateId);
    const containerName = containerPath.split(/[/\\]/).pop() || '';

    // Special templates: directly call createNoteWithTemplate (it will show its own modal)
    if (SPECIAL_TEMPLATE_IDS.includes(templateId)) {
      createNoteWithTemplate('', templateId, containerPath)
        .then(async (notePath) => {
          await fileTreeActions.refreshFileTree();
          refreshActions.incrementSearchRefresh();
          hoverActions.open(notePath);
        })
        .catch(err => console.error('RibbonBar: Failed to create note:', err));
      return;
    }

    // Regular templates: show title input modal first
    modalActions.showTitleInputModal(async (result) => {
      if (result.title.trim()) {
        try {
          const notePath = await createNoteWithTemplate(result.title.trim(), templateId, containerPath);
          await fileTreeActions.refreshFileTree();
          refreshActions.incrementSearchRefresh();
          hoverActions.open(notePath);
        } catch (e) {
          console.error('RibbonBar: Failed to create note:', e);
        }
      }
    }, t('enterNoteTitle', language), `${t('newNoteDefault', language)} - ${templateInfo.name} (${containerName})`);
  };

  const getTemplateInfo = (templateId: string): { prefix: string; name: string; noteType: string; customColor?: string } => {
    const tmpl = noteTemplates.find(t => t.id === templateId);
    return {
      prefix: tmpl?.prefix || '?',
      name: tmpl?.name || t('unknownType', language),
      noteType: tmpl?.frontmatter?.type?.toLowerCase() || tmpl?.prefix?.toLowerCase() || 'note',
      customColor: tmpl?.customColor
    };
  };

  // Truncate container name for button display
  const truncateName = (name: string, maxLen: number = 8): string => {
    if (name.length <= maxLen) return name;
    return name.slice(0, maxLen - 1) + '…';
  };

  return (
    <div className="ribbon-bar">
      <div className="ribbon-buttons">
        {storageContainers.map(node => {
          const config = containerConfigs[node.path];
          const templateInfo = config?.assignedTemplateId
            ? getTemplateInfo(config.assignedTemplateId)
            : { prefix: '?', name: t('unknownType', language), noteType: 'note', customColor: undefined };
          const iconClass = `icon-${templateInfo.noteType}`;
          return (
            <button
              key={node.path}
              className={`ribbon-btn ${templateInfo.noteType}-type`}
              onClick={() => handleRibbonClick(node.path)}
              title={tf('newNoteCreateTitle', language, { container: node.name, template: templateInfo.name })}
              style={templateInfo.customColor ? { '--template-color': templateInfo.customColor } as React.CSSProperties : undefined}
            >
              <span
                className={`ribbon-btn-icon template-selector-icon ${iconClass}`}
                style={templateInfo.customColor ? { backgroundColor: templateInfo.customColor } : undefined}
              />
              <span className="ribbon-btn-name">{truncateName(node.name)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default RibbonBar;
