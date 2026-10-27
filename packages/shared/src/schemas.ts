import { z } from 'zod';
import { LIMITS } from './constants';

const finite = z.number().finite();

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id');
export const uuidSchema = z.uuid();
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb');
export const accountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, - and _');
export const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.titleChars)
  // no control characters: titles are typed into terminals as message prefixes
  .regex(/^[^\p{Cc}]+$/u, 'title cannot contain control characters');
export const absPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), 'must be an absolute path')
  .refine((p) => !p.includes('\0'), 'invalid path');

export const layoutSchema = z.object({
  x: finite,
  y: finite,
  w: finite.min(160).max(8000),
  h: finite.min(100).max(8000),
});

export const launchArgsSchema = z
  .array(z.string().min(1).max(LIMITS.launchArgChars).regex(/^[^\p{Cc}]+$/u))
  .max(LIMITS.launchArgs);

/** UTF-8 size: the unit tmux and the kernel measure command lines in. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** First task of a launched node: multi-line text, no other control characters. */
export const taskSchema = z
  .string()
  .max(LIMITS.taskBytes)
  .regex(/^(?:[^\p{Cc}]|[\n\t])*$/u, 'the task cannot contain control characters')
  .refine((t) => utf8Bytes(t) <= LIMITS.taskBytes, `the task is longer than ${LIMITS.taskBytes / 1024} KB`);

const nodeKindSchema = z.enum(['claude', 'codex', 'kiro', 'shell']);

export const newNodeSchema = z.object({
  kind: nodeKindSchema,
  title: titleSchema,
  cwd: absPathSchema,
  accountId: accountIdSchema.nullable(),
  launchArgs: launchArgsSchema.default([]),
  layout: layoutSchema.optional(),
  /** Typed as the agent's first prompt (first launch only). */
  task: taskSchema.optional(),
});
export type NewNodeInput = z.input<typeof newNodeSchema>;

export const nodePatchSchema = z.object({
  title: titleSchema.optional(),
  layout: layoutSchema.optional(),
});
export type NodePatch = z.infer<typeof nodePatchSchema>;

export const templateInputSchema = z.object({
  name: titleSchema,
  kind: nodeKindSchema,
  title: z.string().trim().max(LIMITS.titleChars).regex(/^[^\p{Cc}]*$/u, 'title cannot contain control characters').default(''),
  cwd: absPathSchema,
  accountId: accountIdSchema.nullable(),
  launchArgs: launchArgsSchema.default([]),
  w: layoutSchema.shape.w,
  h: layoutSchema.shape.h,
});
export type TemplateInput = z.input<typeof templateInputSchema>;

/** Font sizes offered for canvas texts (S, M, L, XL). */
export const ANNOTATION_FONT_SIZES = [14, 20, 32, 48] as const;

const annotationLayout = {
  x: finite,
  y: finite,
  w: finite.min(40).max(20000),
  h: finite.min(24).max(20000),
};
const annotationText = z
  .string()
  .max(LIMITS.annotationChars)
  // multi-line text is fine; other control characters are not
  .regex(/^(?:[^\p{Cc}]|\n)*$/u, 'text cannot contain control characters');
const fontSize = z.number().int().min(10).max(96);

export const newAnnotationSchema = z.object({
  kind: z.enum(['group', 'text']),
  text: annotationText.default(''),
  color: colorSchema,
  fontSize: fontSize.default(ANNOTATION_FONT_SIZES[1]),
  ...annotationLayout,
});
export type NewAnnotationInput = z.input<typeof newAnnotationSchema>;

export const annotationPatchSchema = z
  .object({ text: annotationText, color: colorSchema, fontSize, ...annotationLayout })
  .partial();
export type AnnotationPatch = z.infer<typeof annotationPatchSchema>;

export const clipboardWriteSchema = z.object({ text: z.string().min(1).max(LIMITS.clipboardChars) });
/** A link Ctrl+clicked in a terminal; main still checks it is a web link before opening it. */
export const linkOpenSchema = z.object({ url: z.string().min(1).max(LIMITS.linkChars) });
export const ptyPasteSchema = z.object({
  nodeId: idSchema,
  source: z.enum(['selection', 'clipboard']),
  bracketed: z.boolean(),
});

export const newEdgeSchema = z.object({
  source: idSchema,
  target: idSchema,
  direction: z.enum(['one_way', 'both']).default('both'),
});
export type NewEdgeInput = z.input<typeof newEdgeSchema>;

export const accountInputSchema = z.object({
  id: accountIdSchema,
  agent: z.enum(['claude', 'codex']).default('claude'),
  label: z.string().trim().min(1).max(40).regex(/^[^\p{Cc}]+$/u),
  configDir: absPathSchema,
  color: colorSchema,
  cap5h: z.number().int().positive().nullable().default(null),
  cap7d: z.number().int().positive().nullable().default(null),
});
export type AccountInput = z.input<typeof accountInputSchema>;

export const viewportSchema = z.object({ x: finite, y: finite, zoom: finite.min(0.05).max(8) });

export const ptyOpenSchema = z.object({
  nodeId: idSchema,
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
});
export const ptyInputSchema = z.object({
  nodeId: idSchema,
  data: z.string().max(1024 * 1024),
  /** The user scrolled back since the last input: leave scrollback first so the keys reach the program. */
  exitScroll: z.boolean().optional(),
});
export const ptyScrollToSchema = z.object({ nodeId: idSchema, lines: z.number().int().min(0).max(10_000_000) });
export const ptyResizeSchema = ptyOpenSchema;

/* ---------- Agent hook payloads (external contract, parsed leniently) ---------- */

/** Canonical event names. Claude Code uses them natively; Codex adds PermissionRequest/Interrupt. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionEnd',
  'PermissionRequest',
  'Interrupt',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const hookPayloadSchema = z
  .object({
    session_id: z.string().max(200).optional(),
    hook_event_name: z.string().max(100).optional(),
    message: z.string().max(10_000).optional(),
    notification_type: z.string().max(100).optional(),
    source: z.string().max(100).optional(),
    reason: z.string().max(100).optional(),
    tool_name: z.string().max(200).optional(),
    tool_input: z.unknown().optional(),
  })
  .loose();
export type HookPayload = z.infer<typeof hookPayloadSchema>;

/* ---------- Agent API (flowdeck-mcp ↔ app) ---------- */

export const sendToSchema = z.object({
  peer: z.string().trim().min(1).max(LIMITS.titleChars),
  message: z.string().trim().min(1).max(LIMITS.messageChars),
});
export type SendToInput = z.infer<typeof sendToSchema>;

export interface PeerInfo {
  id: string;
  title: string;
  account: string | null;
  state: string;
  canSend: boolean;
  canReceive: boolean;
}

export type SendResult = { status: 'queued' | 'delivered'; messageId: string };

export interface InboxMessage {
  id: string;
  from: string;
  fromTitle: string;
  body: string;
  createdAt: string;
}
