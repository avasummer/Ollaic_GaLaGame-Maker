# 对话编辑 Agent

AI 助手以多轮对话方式理解创作意图,通过函数调用读取项目数据、暂存脚本/角色/记忆的修改。

## 执行模式

### 多步 function-calling 循环
对原生函数调用可靠的供应商(见 `FC_PROVIDERS`:OpenAI、Anthropic、Gemini、DeepSeek、Groq、xAI、Cohere 等),Agent 最多执行 **6 轮**:模型调用读/写工具 → 工具结果回灌 → 继续推理,直至给出结论或产出暂存变更。
- 实现:`runAgentLoop`(`useAiAgent.ts`)。

### legacy 单轮兜底
不支持函数调用的供应商(如 Ollama、部分自建端点),一次性收到完整上下文,必须在单条响应里返回 JSON 补丁(patch)或纯聊天回复。
- 实现:`runLegacyTurn`(`useAiAgent.ts`)。

## 可用工具

定义于 `lib/ai-tools.ts`。读工具只读、支持分页与上下文截断;写工具**只校验并返回暂存负载(StagedWrite),不直接落盘**。

| 类别 | 工具 | 作用 |
|------|------|------|
| 读 | `list_scenes` | 列出项目所有场景 |
| 读 | `read_scene` | 读取某场景的节点(带行号) |
| 读 | `search_assets` | 检索素材库 |
| 读 | `list_characters` / `get_character` | 列出 / 读取角色 |
| 读 | `read_memory` | 读取项目记忆 |
| 写 | `edit_scene` | 暂存对场景的修改 |
| 写 | `create_scene` | 暂存新建场景 |
| 写 | `edit_character` | 暂存角色修改 |
| 写 | `edit_memory` | 暂存项目记忆修改 |

## 系统提示与上下文

精简的系统提示描述工具语义 + 当前场景(带行号)+ WebGAL txt 语法;角色上下文、素材清单、项目记忆按需单独注入。上下文做了截断以适配窗口:当前场景脚本裁到约 120 行(前 40 + 后 80),素材每类最多 24 条,聊天历史保留最近 8 轮,超 500 字的助手历史会被摘要。
- 实现:`buildAgentSystemContext`、`truncateContextMessages`(`story-agent.ts`)。

## 状态机

`useAiAgent` 维护以下状态:
- `idle` 等待输入 → `generating` 首轮生成 → `tooling` 调用工具
- `pending` 变更待确认 → `accepted` / `reverted` / `conflict` 已处理
- `error` 出错(可重试/可跳设置)

面板状态徽标:生成中 / 等待确认 / 需要处理 / 等待输入。

## 流式与健壮性

- **流式**:每轮文本与工具活动在 `AiMessageBubble` 内联渲染(带图标、状态、错误)。
- **重试与冷却**:限流错误触发 30 秒冷却;超时最多重试 2 次。
- **停止**:生成过程中可中断。

## 相关源码
- `design/src/app/hooks/useAiAgent.ts`(`runAgentLoop` / `runLegacyTurn` / `sendPrompt` / `stop` / `retry`)
- `design/src/app/lib/ai-tools.ts`、`design/src/app/lib/story-agent.ts`
- `design/src/app/components/AiMessageBubble.tsx`
