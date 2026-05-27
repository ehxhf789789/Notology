import { useFileTree } from '../stores/zustand';
import { useContainerConfigs } from '../../features/vault-config/stores/vaultConfigStore';
import { useTemplateStore } from '../../features/templates/stores/templateStore';
import { useSettingsStore } from '../stores/settingsStore';
import { createNoteFromTemplateInteractive } from '../stores/appActions';
import { t, tf } from '../utils/i18n';

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
    // v18 (2026-05-16, HanBin) — single entry point. Wizard / special-modal /
    // title-modal branching lives in `createNoteFromTemplateInteractive`,
    // shared with Ctrl+N and ContainerView's "+ 새 노트". Previously this
    // branched locally and missed the wizard for user-input vars.
    createNoteFromTemplateInteractive(config.assignedTemplateId, containerPath);
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
