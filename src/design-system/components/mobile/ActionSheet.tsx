/**
 * ActionSheet — iOS-style bottom action sheet for confirms/destructive actions.
 */

interface ActionSheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  title?: string;
  message?: string;
  actions: ActionSheetAction[];
  onCancel: () => void;
}

export function ActionSheet({ title, message, actions, onCancel }: Props) {
  return (
    <>
      <div className="m-action-sheet-backdrop" onClick={onCancel} />
      <div className="m-action-sheet">
        {(title || message) && (
          <div className="m-action-sheet-header">
            {title && <div className="m-action-sheet-title">{title}</div>}
            {message && <div className="m-action-sheet-message">{message}</div>}
          </div>
        )}
        <div className="m-action-sheet-actions">
          {actions.map((a, i) => (
            <button
              key={i}
              className={`m-action-sheet-btn ${a.destructive ? 'm-action-sheet-btn--destructive' : ''}`}
              onClick={a.onPress}
            >
              {a.label}
            </button>
          ))}
        </div>
        <button className="m-action-sheet-cancel" onClick={onCancel}>취소</button>
      </div>
    </>
  );
}
