import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { aiChatTurn, getAiConfig, type AiChatMessage } from '../lib/ai-ipc';
import { listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import { updateCharacter } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import {
  describeEdit,
  stageCharacterEdit,
  stageMemoryEdit,
  stageSceneEdit,
  summarizeChangeSet,
  type ChangeEdit,
  type CharacterEdit,
  type MemoryEdit,
  type PendingChangeSet,
  type SceneEdit,
  type StageError,
  type StagingContext,
} from '../lib/change-set';
import { extractEditorResponse } from '../lib/editor-patch';
import { getTool, toolDefs, type StagedWrite } from '../lib/ai-tools';
import {
  buildMemoryContext,
  emptyProjectMemory,
  readProjectMemory,
  saveProjectMemory,
  type ProjectMemory,
} from '../lib/project-memory';
import {
  buildAssetContext,
  buildNumberedScriptContext,
  hasAssetContextTruncation,
  truncateContextMessages,
  type MissingAssetIssue,
} from '../lib/story-agent';
import { getScenePath, parseScene, readFileText, saveScene } from '../lib/webgal-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import { useChatSession, type ChatMessage } from './useChatSession';

export type AiPanelStatus =
  | 'idle'
  | 'generating'
  | 'tooling'
  | 'pending'
  | 'accepted'
  | 'reverted'
  | 'conflict'
  | 'error';

export interface AiErrorState {
  message: string;
  kind: 'auth' | 'rate_limit' | 'timeout' | 'other';
  retryable: boolean;
}

/** Providers with reliable native function-calling support. Others fall back. */
const FC_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'groq', 'xai', 'cohere']);
const MAX_TURNS = 6;

export const INITIAL_AI_MESSAGE: ChatMessage = {
  id: '1',
  role: 'assistant',
  content: '你好，我是故事编辑助手。你可以告诉我想续写剧情、调整对白、删除片段，或一起讨论场景节奏和人物表现。我可以查阅其他场景、素材库和角色设定，并跨场景/角色提出修改。',
};

interface UseAiAgentParams {
  projectId?: string;
  projectPath: string | null;
  currentSceneName: string;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  scriptSource: string;
  dirty: boolean;
  characters: Character[];
  setNodes: (nodes: WebGalNode[]) => void;
  setScriptSource: (source: string) => void;
  setDirty: (dirty: boolean) => void;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setSelectedNode: (node: WebGalNode | null) => void;
  setShowScript: (show: boolean) => void;
  pushHistory: (nodes: WebGalNode[]) => void;
}

function buildCharacterContext(chars: Character[]): string {
  if (chars.length === 0) return '';
  return chars.map(c => {
    const parts: string[] = [`- ${c.name}（id: ${c.id}）`];
    if (c.aliases.length > 0) parts.push(`  别名: ${c.aliases.join(', ')}`);
    if (c.personality) parts.push(`  性格: ${c.personality}`);
    if (c.dialogueStyle) parts.push(`  对话风格: ${c.dialogueStyle}`);
    return parts.join('\n');
  }).join('\n');
}

function classifyAiError(raw: string): AiErrorState {
  const lower = raw.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return { kind: 'auth', retryable: false, message: 'API Key 无效，请前往设置重新配置' };
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return { kind: 'rate_limit', retryable: true, message: '上游 AI 服务返回 429 限流，请稍后再试。这通常是 API 厂商、模型服务或中转平台的速率/并发限制，不是本项目里的 AI 设置限制。' };
  }
  if (lower.includes('timeout') || lower.includes('connection refused')) {
    return { kind: 'timeout', retryable: true, message: '连接超时，请检查网络' };
  }
  return { kind: 'other', retryable: true, message: `AI 服务出错：${raw}` };
}

function stepLabelForTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_scenes': return '正在列出场景…';
    case 'read_scene': return `正在读取场景 ${String(args.name ?? '')}…`;
    case 'search_assets': return '正在查询素材库…';
    case 'list_characters': return '正在列出角色…';
    case 'get_character': return '正在读取角色设定…';
    case 'read_memory': return '正在读取项目记忆…';
    case 'edit_scene': return `正在准备修改场景 ${String(args.file ?? '')}…`;
    case 'edit_character': return '正在准备修改角色设定…';
    case 'edit_memory': return '正在准备更新项目记忆…';
    default: return `正在执行 ${name}…`;
  }
}

function isStageError(value: unknown): value is StageError {
  return typeof value === 'object' && value !== null && typeof (value as StageError).message === 'string';
}

export function useAiAgent(params: UseAiAgentParams) {
  const navigate = useNavigate();
  const {
    projectId,
    projectPath,
    currentSceneName,
    nodes,
    scriptSource,
    dirty,
    characters,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
  } = params;

  const { messages, setMessages, clearMessages } = useChatSession(projectId, currentSceneName, INITIAL_AI_MESSAGE);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiPanelStatus>('idle');
  const [stepLabel, setStepLabel] = useState('');
  const [pendingChangeSet, setPendingChangeSet] = useState<PendingChangeSet | null>(null);
  const [error, setError] = useState<AiErrorState | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const cancelledRef = useRef(false);
  const streamingIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  // Reset transient state when switching scenes.
  useEffect(() => {
    cancelledRef.current = true;
    streamingIdRef.current = null;
    inFlightRef.current = false;
    setBusy(false);
    setStatus('idle');
    setStepLabel('');
    setPendingChangeSet(null);
    setError(null);
    setInput('');
  }, [currentSceneName]);

  useEffect(() => {
    if (!projectPath) {
      setAssets([]);
      setMemory(null);
      return;
    }
    let cancelled = false;
    listAllAssets(projectPath).then((list) => { if (!cancelled) setAssets(list); }).catch(() => { if (!cancelled) setAssets([]); });
    readProjectMemory(projectPath).then((value) => { if (!cancelled) setMemory(value); }).catch(() => { if (!cancelled) setMemory(null); });
    return () => { cancelled = true; };
  }, [projectPath]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const replaceAssistantMessage = useCallback((messageId: string, content: string, extra?: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(message => (message.id === messageId ? { ...message, content, ...extra } : message)));
  }, [setMessages]);

  // Slim system prompt for the tool-calling loop: current scene + "fetch on demand".
  const buildAgentSystemContext = useCallback((): string => {
    return [
      '你是 WebGAL 视觉小说的故事编辑助手，工作在一个支持工具调用的多步循环中。',
      '你可以调用只读工具按需获取信息：list_scenes 列出场景、read_scene 读取某场景带行号脚本、search_assets 查询素材、list_characters/get_character 查角色、read_memory 读项目记忆。先按需查询，再动手。',
      '修改通过写入工具产出，不会立即生效，会先生成预览供用户确认：',
      'edit_scene 对场景应用补丁（insert/delete/replace，行号对应 read_scene 返回的 txt 行号，尽量带 anchorText 原样复制目标行）；edit_character 改角色字段；edit_memory 改项目记忆。',
      '可以在一次循环中对多个场景/角色提出修改，它们会汇总成一个变更集统一审批。',
      '重要：当用户要求修改/续写/调整内容时，必须直接调用写入工具（edit_scene 等）实际执行，不要只用文字说“现在开始续写”“我将…”而不调用工具。光描述意图不会产生任何修改。',
      'WebGAL txt 格式：旁白 :文本; 对话 角色名:文本; 注释 ;注释内容 背景 changeBg:文件名 -next; 立绘 changeFigure:文件名 -left/-right/-center -next; BGM bgm:文件名; 音效 playEffect:文件名; 选择 choose:标签A:场景A.txt|标签B:场景B.txt; 跳转 changeScene:场景.txt;',
      '引用素材只能用 search_assets 返回的真实文件名，缺少素材时直接说明，不要编造。',
      '如果用户只是讨论而无需改动，直接用自然语言回答，不要调用写入工具。',
      `当前打开的场景文件：${currentSceneName}`,
      `当前场景脚本（行号为 txt 行号）：\n${buildNumberedScriptContext(scriptSource, 9999)}`,
    ].join('\n\n');
  }, [currentSceneName, scriptSource]);

  // Full-context single-shot prompt for providers without function calling.
  const buildLegacySystemContext = useCallback((): string => {
    return [
      '你是 WebGAL txt 脚本编辑器助手。',
      '输出规则：只输出一个 JSON 对象，不要 Markdown 包裹，不要解释。',
      '需要修改脚本时返回 {"patches":[...]}；只聊天讨论时返回 {"type":"chat","message":"..."}。',
      'patch type 只能是 insert、delete、replace。file 必须是当前场景文件名。',
      'insert: {"type":"insert","file":"...","afterLine":正整数或"end","anchorText":"对应行原文","text":"WebGAL txt"}。',
      'delete: {"type":"delete","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文"}。',
      'replace: {"type":"replace","file":"...","startLine":正整数,"endLine":正整数,"anchorText":"起始行原文","text":"WebGAL txt"}。',
      '行号必须对应下方带行号脚本中的 txt 行号。anchorText 请原样复制目标行完整文本。',
      'text 字段直接写 WebGAL txt 行，多行用 \\n 分隔。',
      '引用素材时只能使用当前素材库列表中的文件名，缺少素材时返回 chat 说明，不要编造。',
      buildAssetContext(assets),
      buildCharacterContext(characters),
      buildMemoryContext(memory),
      `当前场景文件：${currentSceneName}`,
      `当前脚本（左侧数字是 txt 行号）：\n${buildNumberedScriptContext(scriptSource)}`,
    ].filter(Boolean).join('\n\n');
  }, [assets, characters, currentSceneName, memory, scriptSource]);

  const buildStagingContext = useCallback((): StagingContext => ({
    currentSceneName,
    currentScriptSource: scriptSource,
    currentNodes: nodes,
    assets,
    readSceneContent: async (file: string) => {
      if (!projectPath) throw new Error('当前没有打开的项目。');
      const path = await getScenePath(projectPath, file);
      return readFileText(path);
    },
    getCharacter: (id: string) => characters.find((c) => c.id === id),
    memory: memory ?? emptyProjectMemory(),
  }), [assets, characters, currentSceneName, memory, nodes, projectPath, scriptSource]);

  // Turn a finished set of staged edits into a pending change set + live preview.
  const finalizeChangeSet = useCallback((edits: ChangeEdit[], sourceMessageId: string) => {
    if (edits.length === 0) return false;
    const changeSet: PendingChangeSet = {
      id: `cs-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceMessageId,
      status: 'pending',
      edits,
    };
    const currentSceneEdit = edits.find((e): e is SceneEdit => e.kind === 'scene' && e.isCurrent);
    if (currentSceneEdit) {
      setNodes(currentSceneEdit.afterNodes);
      setScriptSource(currentSceneEdit.afterContent);
      setSelectedNode(null);
      setShowScript(false);
      setDirty(true);
      setSaveStatus('idle');
    }
    replaceAssistantMessage(sourceMessageId, `已生成修改预览：${summarizeChangeSet(changeSet)}`);
    setPendingChangeSet(changeSet);
    setStatus('pending');
    setError(null);
    return true;
  }, [replaceAssistantMessage, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode, setShowScript]);

  // --- Function-calling agent loop ----------------------------------------
  const runAgentLoop = useCallback(async (text: string, assistantId: string) => {
    const stagingCtx = buildStagingContext();
    const sceneEdits = new Map<string, SceneEdit>();
    const charEdits = new Map<string, CharacterEdit>();
    let memEdit: MemoryEdit | undefined;

    const stage = async (staged: StagedWrite): Promise<string> => {
      try {
        if (staged.tool === 'edit_scene') {
          sceneEdits.set(staged.file, await stageSceneEdit(sceneEdits.get(staged.file), staged, stagingCtx));
        } else if (staged.tool === 'edit_character') {
          charEdits.set(staged.id, stageCharacterEdit(charEdits.get(staged.id), staged, stagingCtx));
        } else {
          memEdit = stageMemoryEdit(memEdit, staged, stagingCtx);
        }
        return JSON.stringify({ staged: true, message: '已暂存，等待用户确认。' });
      } catch (e) {
        const msg = isStageError(e) ? e.message : String(e);
        return JSON.stringify({ staged: false, error: msg });
      }
    };

    const convo: AiChatMessage[] = [
      { role: 'system', content: buildAgentSystemContext() },
      ...truncateContextMessages(messages, 8),
      { role: 'user', content: text },
    ];

    let finalText = '';
    let nudged = false;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (cancelledRef.current) return;
      setStatus(turn === 0 ? 'generating' : 'tooling');
      setStepLabel(turn === 0 ? '思考中…' : '继续分析…');
      const res = await aiChatTurn(convo, toolDefs());
      if (cancelledRef.current) return;

      if (res.toolCalls.length === 0) {
        const staged = sceneEdits.size > 0 || charEdits.size > 0 || memEdit !== undefined;
        // Model replied with text but called no tool. If it hasn't actually
        // produced any edit yet and we haven't nudged, it may be announcing an
        // action without performing it ("现在开始续写…"). Nudge once: either call
        // the tool, or confirm it's only discussing. A second text-only reply is
        // treated as a genuine chat answer.
        if (!staged && !nudged) {
          nudged = true;
          convo.push({ role: 'assistant', content: res.text ?? '' });
          convo.push({
            role: 'user',
            content:
              '如果你打算修改脚本/角色/记忆，请立即调用相应工具（如 edit_scene）实际执行，不要只用文字描述将要做的事。如果你只是讨论或回答问题，无需调用工具，直接给出最终回复即可。',
          });
          continue;
        }
        finalText = res.text ?? '';
        break;
      }

      convo.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        setStepLabel(stepLabelForTool(call.name, call.arguments));
        const tool = getTool(call.name);
        let content: string;
        if (!tool) {
          content = JSON.stringify({ error: `未知工具：${call.name}` });
        } else if (tool.kind === 'write') {
          const staged = (await tool.run(call.arguments, { projectPath, currentSceneName })) as StagedWrite;
          content = await stage(staged);
        } else {
          try {
            content = JSON.stringify(await tool.run(call.arguments, { projectPath, currentSceneName }));
          } catch (e) {
            content = JSON.stringify({ error: String(e) });
          }
        }
        convo.push({ role: 'tool', content, toolCallId: call.id });
      }
      if (turn === MAX_TURNS - 1) {
        finalText = res.text ?? '已达到最大工具调用轮数。';
      }
    }

    const edits: ChangeEdit[] = [...sceneEdits.values(), ...charEdits.values(), ...(memEdit ? [memEdit] : [])];
    setStepLabel('');
    if (!finalizeChangeSet(edits, assistantId)) {
      replaceAssistantMessage(assistantId, finalText || '（无可执行的修改）');
      setStatus('idle');
    }
  }, [buildAgentSystemContext, buildStagingContext, currentSceneName, finalizeChangeSet, messages, projectPath, replaceAssistantMessage]);

  // --- Legacy single-shot for providers without function calling ----------
  const runLegacyTurn = useCallback(async (text: string, assistantId: string) => {
    setStatus('generating');
    setStepLabel('思考中…');
    const convo: AiChatMessage[] = [
      { role: 'system', content: buildLegacySystemContext() },
      ...truncateContextMessages(messages, 8),
      { role: 'user', content: text },
    ];
    const res = await aiChatTurn(convo, []);
    if (cancelledRef.current) return;
    setStepLabel('');
    const parsed = res.text ? extractEditorResponse(res.text) : null;
    if (!parsed) {
      replaceAssistantMessage(assistantId, res.text || 'AI 没有返回可执行方案，请重新描述你的需求。');
      setStatus('idle');
      return;
    }
    if (parsed.type === 'chat') {
      replaceAssistantMessage(assistantId, parsed.message);
      setStatus('idle');
      return;
    }
    try {
      const edit = await stageSceneEdit(undefined, { tool: 'edit_scene', file: currentSceneName, patches: parsed.patches }, buildStagingContext());
      if (!finalizeChangeSet([edit], assistantId)) {
        replaceAssistantMessage(assistantId, '（patch 应用后没有变化）');
        setStatus('idle');
      }
    } catch (e) {
      const msg = isStageError(e) ? e.message : String(e);
      setStatus('error');
      setError({ kind: 'other', retryable: true, message: msg });
    }
  }, [buildLegacySystemContext, buildStagingContext, currentSceneName, finalizeChangeSet, messages, replaceAssistantMessage]);

  const sendPrompt = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy || inFlightRef.current) return;
    if (pendingChangeSet?.status === 'pending') {
      setError({ kind: 'other', retryable: false, message: '当前还有 AI 修改方案待确认。请先接受或撤销后再继续对话。' });
      return;
    }
    inFlightRef.current = true;
    cancelledRef.current = false;
    setLastPrompt(text);
    setError(null);
    setPendingChangeSet(null);
    setStatus('generating');

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    streamingIdRef.current = assistantId;
    setMessages([...messages, { id: userId, role: 'user', content: text }, { id: assistantId, role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    try {
      const cfg = await getAiConfig();
      const useFc = FC_PROVIDERS.has(cfg.provider);
      if (useFc) await runAgentLoop(text, assistantId);
      else await runLegacyTurn(text, assistantId);
      setRetryCount(0);
    } catch (e) {
      if (!cancelledRef.current) {
        setStatus('error');
        const classified = classifyAiError(String(e));
        setError(classified);
        if (classified.kind === 'rate_limit') setCooldown(30);
        replaceAssistantMessage(assistantId, `（错误：${classified.message}）`);
      }
    } finally {
      inFlightRef.current = false;
      streamingIdRef.current = null;
      setBusy(false);
      setStepLabel('');
    }
  }, [busy, messages, pendingChangeSet, replaceAssistantMessage, runAgentLoop, runLegacyTurn, setMessages]);

  const retry = useCallback(() => {
    if (!lastPrompt || busy || cooldown > 0) return;
    if (error?.kind === 'timeout' && retryCount >= 2) return;
    setRetryCount((value) => value + 1);
    void sendPrompt(lastPrompt);
  }, [busy, cooldown, error?.kind, lastPrompt, retryCount, sendPrompt]);

  // Persist all edits atomically (all-or-rollback). No conflict guard — callers
  // decide whether the current scene's live buffer is allowed to differ.
  const persistChangeSet = useCallback(async (set: PendingChangeSet) => {
    if (!projectPath) return;
    const currentSceneEdit = set.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.isCurrent);
    const applied: ChangeEdit[] = [];
    try {
      for (const edit of set.edits) {
        if (edit.kind === 'scene') {
          const path = await getScenePath(projectPath, edit.file);
          await saveScene(path, edit.afterNodes);
        } else if (edit.kind === 'character') {
          await updateCharacter(projectPath, edit.after);
        } else {
          await saveProjectMemory(projectPath, edit.after);
          setMemory(edit.after);
        }
        applied.push(edit);
      }
    } catch (e) {
      // Roll back everything already written, in reverse order.
      for (const edit of applied.reverse()) {
        try {
          if (edit.kind === 'scene') {
            const path = await getScenePath(projectPath, edit.file);
            await saveScene(path, edit.beforeNodes);
          } else if (edit.kind === 'character') {
            await updateCharacter(projectPath, edit.before);
          } else {
            await saveProjectMemory(projectPath, edit.before);
            setMemory(edit.before);
          }
        } catch { /* best-effort rollback */ }
      }
      setStatus('error');
      setError({ kind: 'other', retryable: false, message: `落盘失败，已回滚全部修改：${String(e)}` });
      setPendingChangeSet({ ...set, status: 'failed' });
      return;
    }

    if (currentSceneEdit) {
      pushHistory(currentSceneEdit.beforeNodes);
      setDirty(false);
      setSaveStatus('saved');
    }
    replaceAssistantMessage(set.sourceMessageId, `已接受修改：${summarizeChangeSet(set)}`, {
      diff: currentSceneEdit?.diff,
    });
    setPendingChangeSet({ ...set, status: 'accepted' });
    setStatus('accepted');
  }, [projectPath, pushHistory, replaceAssistantMessage, setDirty, setSaveStatus]);

  const acceptChange = useCallback(async () => {
    if (!pendingChangeSet || pendingChangeSet.status !== 'pending' || !projectPath) return;
    // Conflict guard: the current scene's live buffer must still match our preview.
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.isCurrent);
    if (currentSceneEdit && scriptSource !== currentSceneEdit.afterContent) {
      setStatus('conflict');
      return;
    }
    await persistChangeSet(pendingChangeSet);
  }, [pendingChangeSet, persistChangeSet, projectPath, scriptSource]);

  const revertChange = useCallback(() => {
    if (!pendingChangeSet) return;
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.isCurrent);
    if (currentSceneEdit) {
      setNodes(currentSceneEdit.beforeNodes);
      setScriptSource(currentSceneEdit.beforeContent);
      setSelectedNode(null);
      setDirty(dirty);
      setSaveStatus('idle');
    }
    replaceAssistantMessage(pendingChangeSet.sourceMessageId, `已撤销：${summarizeChangeSet(pendingChangeSet)}`);
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('reverted');
  }, [dirty, pendingChangeSet, replaceAssistantMessage, setDirty, setNodes, setSaveStatus, setScriptSource, setSelectedNode]);

  const forceApplyChange = useCallback(async () => {
    if (!pendingChangeSet) return;
    // User chose to overwrite their manual edits with the AI preview.
    const currentSceneEdit = pendingChangeSet.edits.find((e): e is SceneEdit => e.kind === 'scene' && e.isCurrent);
    if (currentSceneEdit) {
      pushHistory(nodes);
      setNodes(currentSceneEdit.afterNodes);
      setScriptSource(currentSceneEdit.afterContent);
    }
    await persistChangeSet(pendingChangeSet);
  }, [nodes, pendingChangeSet, persistChangeSet, pushHistory, setNodes, setScriptSource]);

  const regenerateAfterConflict = useCallback(() => {
    if (!pendingChangeSet) return;
    setPendingChangeSet({ ...pendingChangeSet, status: 'reverted' });
    setStatus('idle');
    setInput('请基于我当前最新的脚本内容，重新生成一个不覆盖我手动修改的方案。');
  }, [pendingChangeSet]);

  const openAssets = useCallback(() => {
    if (projectId) navigate(`/editor/${projectId}/assets`);
  }, [navigate, projectId]);

  const clearConversation = useCallback(() => {
    if (busy) return;
    if (pendingChangeSet?.status === 'pending') revertChange();
    clearMessages();
    setInput('');
    setError(null);
    setStatus('idle');
  }, [busy, clearMessages, pendingChangeSet, revertChange]);

  const saveMemory = useCallback(async (next: ProjectMemory) => {
    if (!projectPath) return;
    const payload = next ?? emptyProjectMemory();
    await saveProjectMemory(projectPath, payload);
    setMemory(payload);
  }, [projectPath]);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    const stoppedId = streamingIdRef.current;
    streamingIdRef.current = null;
    inFlightRef.current = false;
    if (stoppedId) {
      setMessages(prev => prev.map(message => (message.id === stoppedId ? { ...message, stopped: true } : message)));
    }
    setBusy(false);
    setStatus('idle');
    setStepLabel('');
  }, [setMessages]);

  return {
    messages,
    input,
    setInput,
    busy,
    status,
    stepLabel,
    pendingChangeSet,
    error,
    cooldown,
    hasAssetTruncation: hasAssetContextTruncation(assets),
    memory,
    streamingIdRef,
    describeEdit,
    sendPrompt,
    acceptChange,
    revertChange,
    forceApplyChange,
    regenerateAfterConflict,
    openAssets,
    retry,
    clearConversation,
    saveMemory,
    stop,
  };
}
