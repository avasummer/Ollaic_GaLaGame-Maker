# 角色音色绑定（修复 CosyVoice 418）

## 背景与根因
配音面板把 `voicePrompt` 拼成「角色名 + 情绪」（如 `"制作人 微笑"`）直接当成 CosyVoice 的 `voice`（音色 ID）发出去。CosyVoice 的 voice 必须是固定音色 ID（如 `longxiaochun_v2`），收到中文描述 → 引擎回 418。

根本解法：给每个角色绑定一个音色 ID，配音时传这个 ID。

## 关键发现
- 类型层已预留字段：前端 `Character.voiceTimbre?: string`、后端 `voice_timbre: Option<String>`（无需改类型定义）。
- 后端 TTS 已把 `voice_prompt` 直接当音色透传（`generate_dashscope_cosyvoice_ws` 等），**后端几乎不用改**。
- 配音面板可用 `listCharacters(projectPath)` 自行加载角色，拿到「角色名 → 音色」映射。
- 配音卡 `card.character` 存的是角色名，不是 id，所以按角色名匹配音色。

## 用户已确认的决策
1. 音色填写方式：**下拉预设 + 可手填**（兼顾易用与自定义/海外音色）。
2. 角色未设音色时：**用默认音色并提示**（不阻断生成）。

## 改动清单

### 1. 前端：角色基本信息加「音色」字段
`design/src/app/components/CharacterPanel.tsx`
- 在基本信息区（性别/年龄附近）加一个「音色」控件：`<input list>` 组合（下拉预设 + 可手填），绑定 `selected.voiceTimbre`，`onChange` → `patchCharacter(id, { voiceTimbre })`。
- 新增一份 CosyVoice 常用音色预设常量（含 v1/v2 代表音色 + 标签），供 datalist 选项；用户也可手填任意 ID。

### 2. 前端：配音面板传角色音色，并展示
`design/src/app/components/VoiceDubbingPanel.tsx`
- 组件加载时 `listCharacters(projectPath)`，构建 `Map<角色名, voiceTimbre>`。
- 生成 items 时，`voicePrompt` 改为：该角色的 `voiceTimbre`，缺省留空（让后端用默认音色）。
- 列表每张卡 / 角色分组头展示该角色的音色（如标签 `音色: longxiaochun_v2`）；未设置的显示「默认音色」提示。
- 批量生成对话框里列出涉及的角色及其音色，未设置的高亮提示「将使用默认音色」。

### 3. 后端：默认音色提示（可选增强）
`src-tauri/src/ai/commands.rs`
- 当前 cosyvoice 缺省已按模型版本给默认音色，保持即可。
- 可选：voice_prompt 为空时在日志里标注「使用默认音色」，便于排查。基本无需改。

## 不做的事
- 不引入新的音色管理面板；音色就挂在角色基本信息里。
- 不改 characters.json 结构（字段已存在）。
- 不改后端 TTS 协议逻辑（CosyVoice WebSocket 已实现并编译通过）。

## 验证
- 前端 `tsc --noEmit`。
- 手动：给角色设音色 `longxiaochun_v2` → 配音面板显示该音色 → 生成成功（不再 418）；不设音色的角色 → 提示默认音色 → 仍能生成。
