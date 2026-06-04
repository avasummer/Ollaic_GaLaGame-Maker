import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AiProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'groq'
  | 'xai'
  | 'ollama'
  | 'cohere'
  | 'custom';

export interface AiConfig {
  provider: AiProvider | string;
  model: string;
  api_key: string;
  base_url: string;
}

export interface AiValidationResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string;
  message: string;
}

export interface AiLogEntry {
  timestampMs: number;
  action: string;
  provider: string;
  model: string;
  endpoint: string;
  success: boolean;
  message: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Assistant turns that requested tools: replayed so the provider keeps context. */
  toolCalls?: AiToolCall[];
  /** role === 'tool': the originating tool call id this content answers. */
  toolCallId?: string;
}

/** A tool the model may call, described with a JSON Schema for its parameters. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

/** A tool call emitted by the model in one turn. */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of one non-streaming agent turn: either tool calls or final text. */
export interface AiTurnResult {
  text: string | null;
  toolCalls: AiToolCall[];
}

export type AiStreamEvent =
  | { type: 'start' }
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export async function getAiConfig(): Promise<AiConfig> {
  return invoke<AiConfig>('get_ai_config');
}

export async function setAiConfig(config: AiConfig): Promise<void> {
  return invoke<void>('set_ai_config', { config });
}

export async function validateAiConfig(config: AiConfig): Promise<AiValidationResult> {
  return invoke<AiValidationResult>('validate_ai_config', { config });
}

export async function listAiLogs(limit?: number): Promise<AiLogEntry[]> {
  return invoke<AiLogEntry[]>('list_ai_logs', { limit: limit ?? null });
}

export async function clearAiLogs(): Promise<void> {
  return invoke<void>('clear_ai_logs');
}

export async function getAiLogPath(): Promise<string> {
  return invoke<string>('get_ai_log_path');
}

export interface StreamHandlers {
  onChunk?: (content: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  onStart?: () => void;
}

export async function aiChatStream(
  messages: AiChatMessage[],
  handlers: StreamHandlers,
  characterContext?: string,
): Promise<{ requestId: string; cancel: () => void }> {
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventName = `ai-chat-${requestId}`;

  let unlisten: UnlistenFn | null = null;
  const stop = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  unlisten = await listen<AiStreamEvent>(eventName, (e) => {
    const payload = e.payload;
    switch (payload.type) {
      case 'start':
        handlers.onStart?.();
        break;
      case 'chunk':
        handlers.onChunk?.(payload.content);
        break;
      case 'done':
        handlers.onDone?.();
        stop();
        break;
      case 'error':
        handlers.onError?.(payload.message);
        stop();
        break;
    }
  });

  try {
    await invoke<void>('ai_chat_stream', { requestId, messages, characterContext });
  } catch (err) {
    stop();
    handlers.onError?.(String(err));
  }

  return { requestId, cancel: stop };
}

/**
 * One non-streaming agent turn. Sends conversation + available tools to the
 * model and returns either tool calls (to execute) or final text. Used by the
 * multi-step agent loop; pure-chat streaming still goes through aiChatStream.
 */
export async function aiChatTurn(
  messages: AiChatMessage[],
  tools: ToolDef[],
  characterContext?: string,
): Promise<AiTurnResult> {
  const wireMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) ?? null,
    tool_call_id: m.toolCallId ?? null,
  }));
  return invoke<AiTurnResult>('ai_chat_turn', {
    messages: wireMessages,
    tools,
    characterContext,
  });
}
