/**
 * AI agent tool registry.
 *
 * Each tool is either:
 *  - 'read'  — executed automatically inside the agent loop; its result is fed
 *              back to the model. Read tools wrap existing IPC and self-truncate
 *              to avoid blowing up the context window.
 *  - 'write' — NOT executed here. The loop "stages" the call into a change set
 *              and the user approves the whole set at the end. The run() of a
 *              write tool just normalizes/echoes its arguments.
 *
 * The model sees tool schemas via ToolDef; the loop dispatches by name.
 */

import type { ToolDef } from './ai-ipc';
import { listAllAssets, listAssets, type AssetInfo } from './assets-ipc';
import { getCharacter, listCharacterNames } from './character-ipc';
import { readProjectMemory } from './project-memory';
import { getScenePath, listScenes, readFileText } from './webgal-ipc';
import type { EditorPatch } from './editor-patch';

export type ToolKind = 'read' | 'write';

export interface AgentTool {
  name: string;
  description: string;
  kind: ToolKind;
  /** JSON Schema for the tool parameters. */
  schema: unknown;
  /** Execute (read) or normalize args (write). Returns a JSON-serializable value. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  projectPath: string | null;
  currentSceneName: string;
}

const SCENE_READ_MAX_LINES = 200;
const ASSET_LIST_LIMIT = 200;

function sceneDir(projectPath: string): string {
  return `${projectPath}/game/scene`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function requireProject(ctx: ToolContext): string {
  if (!ctx.projectPath) throw new Error('当前没有打开的项目，无法读取项目数据。');
  return ctx.projectPath;
}

function numberScript(content: string, fromLine = 1, maxLines = SCENE_READ_MAX_LINES): {
  text: string;
  totalLines: number;
  truncated: boolean;
} {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, fromLine);
  const end = Math.min(lines.length, start + maxLines - 1);
  const slice = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`);
  return {
    text: slice.join('\n'),
    totalLines: lines.length,
    truncated: end < lines.length || start > 1,
  };
}

function summarizeAssets(assets: AssetInfo[], query?: string): unknown {
  let list = assets;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((a) => a.name.toLowerCase().includes(q));
  }
  const truncated = list.length > ASSET_LIST_LIMIT;
  return {
    total: list.length,
    truncated,
    assets: list.slice(0, ASSET_LIST_LIMIT).map((a) => ({ name: a.name, category: a.category })),
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const readTools: AgentTool[] = [
  {
    name: 'list_scenes',
    description: '列出项目中所有场景文件名（game/scene 下的 .txt）。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const scenes = await listScenes(sceneDir(projectPath));
      return { scenes };
    },
  },
  {
    name: 'read_scene',
    description:
      '读取某个场景文件的带行号脚本内容。可用 fromLine/maxLines 分页，避免一次返回过长。返回行号对应 WebGAL txt 行号。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '场景文件名，如 start.txt' },
        fromLine: { type: 'integer', description: '起始行号（默认 1）' },
        maxLines: { type: 'integer', description: `最多返回行数（默认 ${SCENE_READ_MAX_LINES}）` },
      },
      required: ['name'],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const name = asString(args.name);
      if (!name) throw new Error('read_scene 需要场景文件名 name。');
      const path = await getScenePath(projectPath, name);
      const content = await readFileText(path);
      const numbered = numberScript(content, asInt(args.fromLine) ?? 1, asInt(args.maxLines) ?? SCENE_READ_MAX_LINES);
      return { name, ...numbered };
    },
  },
  {
    name: 'search_assets',
    description:
      '查询素材库可用文件。可按 category（background/figure/bgm/sfx/vocal/video）筛选，按 query 子串匹配文件名。引用素材时只能使用这里返回的文件名。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '素材类别，省略则查全部' },
        query: { type: 'string', description: '文件名子串过滤' },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const category = asString(args.category);
      const assets = category ? await listAssets(projectPath, category) : await listAllAssets(projectPath);
      return summarizeAssets(assets, asString(args.query));
    },
  },
  {
    name: 'list_characters',
    description: '列出项目中的角色（id 与名字）。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const characters = await listCharacterNames(projectPath);
      return { characters };
    },
  },
  {
    name: 'get_character',
    description: '获取单个角色的完整设定（性格、对话风格、关系等）。',
    kind: 'read',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '角色 id' } },
      required: ['id'],
    },
    run: async (args, ctx) => {
      const projectPath = requireProject(ctx);
      const id = asString(args.id);
      if (!id) throw new Error('get_character 需要角色 id。');
      return getCharacter(projectPath, id);
    },
  },
  {
    name: 'read_memory',
    description: '读取项目记忆（世界观、写作风格、用户偏好）。',
    kind: 'read',
    schema: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx) => {
      const projectPath = requireProject(ctx);
      const memory = await readProjectMemory(projectPath);
      return memory ?? { worldSetting: '', writingStyle: '', userPreferences: '' };
    },
  },
];

// ---------------------------------------------------------------------------
// Write tools — staged into the change set, not executed here.
// ---------------------------------------------------------------------------

/** Staged write payloads, discriminated by the originating tool name. */
export type StagedWrite =
  | { tool: 'edit_scene'; file: string; patches: EditorPatch[] }
  | { tool: 'edit_character'; id: string; partial: Record<string, unknown> }
  | { tool: 'edit_memory'; partial: Record<string, unknown> };

const writeTools: AgentTool[] = [
  {
    name: 'edit_scene',
    description:
      '对某个场景文件应用补丁（insert/delete/replace）。file 为场景文件名。patches 中行号对应该场景 read_scene 返回的 txt 行号；尽量提供 anchorText（原样复制目标行）以兜底行号漂移。text 为 WebGAL txt，多行用 \\n 分隔。修改不会立即生效，会先生成预览供用户确认。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标场景文件名' },
        patches: {
          type: 'array',
          description: 'EditorPatch 数组',
          items: { type: 'object' },
        },
      },
      required: ['file', 'patches'],
    },
    run: async (args) => {
      const file = asString(args.file);
      if (!file) throw new Error('edit_scene 需要 file。');
      if (!Array.isArray(args.patches)) throw new Error('edit_scene 的 patches 必须是数组。');
      return { tool: 'edit_scene', file, patches: args.patches as EditorPatch[] } satisfies StagedWrite;
    },
  },
  {
    name: 'edit_character',
    description:
      '修改某个角色的设定字段（如 personality、dialogueStyle、stance、description 等）。partial 只包含要改的字段。修改先进入预览，用户确认后才落盘。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色 id' },
        partial: { type: 'object', description: '要更新的字段集合' },
      },
      required: ['id', 'partial'],
    },
    run: async (args) => {
      const id = asString(args.id);
      if (!id) throw new Error('edit_character 需要角色 id。');
      const partial = (args.partial && typeof args.partial === 'object' ? args.partial : {}) as Record<string, unknown>;
      return { tool: 'edit_character', id, partial } satisfies StagedWrite;
    },
  },
  {
    name: 'edit_memory',
    description:
      '更新项目记忆字段（worldSetting/writingStyle/userPreferences）。partial 只包含要改的字段。修改先进入预览。',
    kind: 'write',
    schema: {
      type: 'object',
      properties: {
        partial: { type: 'object', description: '要更新的记忆字段' },
      },
      required: ['partial'],
    },
    run: async (args) => {
      const partial = (args.partial && typeof args.partial === 'object' ? args.partial : {}) as Record<string, unknown>;
      return { tool: 'edit_memory', partial } satisfies StagedWrite;
    },
  },
];

export const AGENT_TOOLS: AgentTool[] = [...readTools, ...writeTools];

const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AgentTool | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Tool definitions sent to the model. */
export function toolDefs(): ToolDef[] {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
}
