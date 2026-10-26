import { memo } from 'react';
import { NodeResizeControl, NodeResizer, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { ANNOTATION_FONT_SIZES, LIMITS, type Annotation } from '@flowdeck/shared';
import { useStore } from '../store/store';
import { DRAW_COLORS, FONT_SIZE_LABEL, deleteAnnotation, saveAnnotation } from './drawing';

export type AnnotationNodeData = { annotationId: string };
export type GroupFlowNode = Node<AnnotationNodeData, 'group-box'>;
export type TextFlowNode = Node<AnnotationNodeData, 'text-box'>;

/** Colour, size (texts) and delete, shown above a selected group or text. */
function AnnotationToolbar({ a, visible }: { a: Annotation; visible: boolean }) {
  return (
    <NodeToolbar
      isVisible={visible}
      position={Position.Top}
      // A group's toolbar sits inside its title bar (right), so it stays on screen with the group.
      {...(a.kind === 'group' ? { align: 'end' as const, offset: -38 } : {})}
      className="fd-draw-toolbar"
      // Above everything: React Flow would give a group's toolbar the group's negative z-index.
      style={{ zIndex: 5000 }}
      data-testid="annotation-toolbar"
    >
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          className={`fd-swatch ${a.color === c ? 'active' : ''}`}
          style={{ background: c }}
          title={`Colour ${c}`}
          onClick={() => saveAnnotation(a.id, { color: c })}
        />
      ))}
      {a.kind === 'text' &&
        ANNOTATION_FONT_SIZES.map((size) => (
          <button
            key={size}
            className={`fd-icon ${a.fontSize === size ? 'active' : ''}`}
            title={`Text size ${FONT_SIZE_LABEL[size]}`}
            onClick={() => saveAnnotation(a.id, { fontSize: size })}
          >
            {FONT_SIZE_LABEL[size]}
          </button>
        ))}
      <button
        className="fd-icon"
        title={a.kind === 'group' ? 'Rename group' : 'Edit text'}
        onClick={() => useStore.getState().setEditingAnnotation(a.id)}
      >
        ✎
      </button>
      <button
        className="fd-icon"
        title={a.kind === 'group' ? 'Delete group (terminals stay)' : 'Delete text'}
        onClick={() => deleteAnnotation(a.id)}
        data-testid="annotation-delete"
      >
        ✕
      </button>
    </NodeToolbar>
  );
}

/** Saves the edited text and leaves edit mode; an empty new text is removed. */
function finishEditing(a: Annotation, value: string): void {
  useStore.getState().setEditingAnnotation(null);
  const text = a.kind === 'group' ? value.trim().slice(0, LIMITS.titleChars) : value.replace(/\r/g, '');
  if (a.kind === 'text' && !text.trim()) {
    deleteAnnotation(a.id);
    return;
  }
  if (text !== a.text) saveAnnotation(a.id, { text });
}

function GroupNodeImpl({ data, selected }: NodeProps<GroupFlowNode>) {
  const a = useStore((s) => s.annotations[data.annotationId]);
  const editing = useStore((s) => s.editingAnnotation === data.annotationId);
  if (!a) return null;
  return (
    <div className="fd-group" style={{ borderColor: a.color, background: `${a.color}12` }} data-testid={`group-${a.id}`}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={80} lineClassName="fd-resize-line" />
      <AnnotationToolbar a={a} visible={selected && !editing} />
      <div
        className="fd-group-header"
        style={{ color: a.color }}
        onDoubleClick={() => useStore.getState().setEditingAnnotation(a.id)}
        title="Drag to move the group and everything inside it. Double-click to rename."
      >
        {editing ? (
          <input
            className="fd-group-input nodrag"
            defaultValue={a.text}
            placeholder="Group name"
            autoFocus
            maxLength={LIMITS.titleChars}
            data-testid="group-title-input"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => finishEditing(a, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = a.text; // the blur then saves nothing
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className={a.text ? '' : 'fd-placeholder'}>{a.text || 'Group'}</span>
        )}
      </div>
    </div>
  );
}

function TextNodeImpl({ data, selected }: NodeProps<TextFlowNode>) {
  const a = useStore((s) => s.annotations[data.annotationId]);
  const editing = useStore((s) => s.editingAnnotation === data.annotationId);
  if (!a) return null;
  const style = { color: a.color, fontSize: a.fontSize };
  return (
    <div className={`fd-text-box ${selected ? 'selected' : ''}`} data-testid={`text-${a.id}`}>
      <NodeResizeControl position={Position.Right} minWidth={80} className="fd-text-resize" />
      <AnnotationToolbar a={a} visible={selected && !editing} />
      {editing ? (
        <textarea
          className="fd-text-input nodrag nowheel"
          style={style}
          defaultValue={a.text}
          placeholder="Write a caption…"
          autoFocus
          maxLength={LIMITS.annotationChars}
          rows={Math.max(2, a.text.split('\n').length)}
          data-testid="text-input"
          onBlur={(e) => finishEditing(a, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = a.text; // unchanged; a new, still empty text is discarded
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className="fd-text" style={style} onDoubleClick={() => useStore.getState().setEditingAnnotation(a.id)}>
          {a.text}
        </div>
      )}
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
export const TextNode = memo(TextNodeImpl);
