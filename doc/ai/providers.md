# 供应商与模型配置

`AiSettingsDialog` 提供 **Chat / Image / TTS 三个标签页**,每类可独立选择供应商、模型、API Key,并可为自建/兼容端点设置 Base URL。带「测试连接」实时校验。

## Chat 供应商(`CHAT_PROVIDERS`)

OpenAI、Anthropic、Gemini、DeepSeek、Groq、xAI、Ollama(本地)、custom(OpenAI 兼容)等。属于 `FC_PROVIDERS` 的供应商启用多步工具调用,其余走 legacy 单轮补丁。

## Image 供应商(`IMAGE_PROVIDERS`)

OpenAI(DALL·E)、Gemini/Imagen、阿里云 DashScope/通义万相、火山/豆包/即梦、智谱 CogView、SiliconFlow(Kolors/FLUX/SD)、Stable Diffusion WebUI(本地)等。

## TTS 供应商(`TTS_PROVIDERS`)

OpenAI、Gemini、ElevenLabs、阿里云 CosyVoice、火山、腾讯云、百度、Azure、MiniMax、讯飞、Edge TTS(本地免费)、custom 等。

> 以上为代码内置的预设清单;具体可用模型以「测试连接」返回为准。

## 调用日志

`listAiLogs` / `clearAiLogs` 记录供应商、模型、动作(chat/image/tts)、端点、成功/失败与消息;可查看最近 80 条并清空。

## 相关源码
- `design/src/app/components/AiSettingsDialog.tsx`(`CHAT_PROVIDERS` / `IMAGE_PROVIDERS` / `TTS_PROVIDERS` / `FC_PROVIDERS` 预设)
- `design/src/app/lib/ai-ipc.ts`(配置读写、连接校验、日志)
