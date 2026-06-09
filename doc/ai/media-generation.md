# AI 素材与立绘生成

除文本编辑外,AI 还能生成图像(背景/CG/立绘)与音频(语音/TTS),用于快速填充素材。

## 图像生成

- 接口:`aiGenerateImage`(`ai-ipc.ts`),输入文本提示 + 模型名,返回 base64 图像。
- **背景 / CG 生成**(`AssetManager.tsx`):输入描述、选择目标模型(支持多模型批量),为「场景 / CG」标签页生成图像;保存时带分类标签并建议可用文件名。
- **角色立绘生成**(`CharacterPanel.tsx`):`buildSpritePrompt()` 结合角色性格、表情与可选指令生成立绘;支持「主体参考图」与各表情变体,生成后自动保存并关联到角色记录。详见[角色立绘](../characters/characters-and-sprites.md)。

## 语音 / TTS 生成

- 接口:`aiGenerateTts`(`ai-ipc.ts`),输入文本 + 语音提示(角色 + 情绪 + 自定义)+ 模型 + 格式。
- 用于生成配音资产(归类于 vocal)。情绪选项含平静、温柔、开心、悲伤等。

## 进度反馈

长耗时的图像/音频任务通过 `listenAiMediaGenerationProgress`(`ai-ipc.ts`)推送事件(供应商、模型、阶段、尝试计数),`AssetManager` 与 `CharacterPanel` 内联展示进度卡。

## 分模态配置

聊天、图像、TTS 各自独立配置,可路由到不同供应商:
- `getAiConfig`(聊天)/ `getAiImageConfig`(图像)/ `getAiTtsConfig`(TTS)。
- 例如:聊天用 OpenAI、图像用 Gemini、TTS 用 ElevenLabs。详见[供应商与模型配置](./providers.md)。

## 相关源码
- `design/src/app/lib/ai-ipc.ts`(`aiGenerateImage` / `aiGenerateTts` / 进度监听 / 各模态配置)
- `design/src/app/components/AssetManager.tsx`、`design/src/app/components/CharacterPanel.tsx`
