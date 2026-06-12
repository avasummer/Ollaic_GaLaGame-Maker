use super::config::{self, AiConfig, AiProviderConfig};
use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{
    ChatMessage, ChatRequest, ChatStreamEvent, StreamChunk, Tool, ToolCall, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};
use base64::Engine;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LIMIT: usize = 500;
const DEFAULT_LOG_LIMIT: usize = 100;
const MAX_LOG_FIELD_CHARS: usize = 1000;
const HTTP_REQUEST_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Deserialize)]
pub struct ToolCallInput {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AiMessageInput {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// For assistant turns that requested tools: the tool calls to replay.
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallInput>>,
    /// For role == "tool": the originating tool call id this content answers.
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the tool parameters.
    pub parameters: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnResult {
    pub text: Option<String>,
    pub tool_calls: Vec<AiToolCall>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Start,
    Chunk { content: String },
    Done,
    Error { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiValidationResult {
    pub ok: bool,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMedia {
    pub base64_data: String,
    pub extension: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMediaGenerationProgress {
    pub provider: String,
    pub model: String,
    pub phase: String,
    pub attempt: u8,
    pub total_attempts: u8,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageResponse {
    data: Vec<OpenAiImageItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageItem {
    #[serde(default)]
    b64_json: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskCreateResponse {
    output: DashScopeTaskOutput,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskOutput {
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task_status: Option<String>,
    #[serde(default)]
    results: Vec<DashScopeImageResult>,
}

#[derive(Debug, Deserialize)]
struct DashScopeImageResult {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsResponse {
    #[serde(default)]
    output: Option<DashScopeTtsOutput>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsOutput {
    #[serde(default)]
    audio: Option<DashScopeTtsAudio>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTtsAudio {
    /// 流式合成时为 Base64 音频数据；非流式时为空。
    #[serde(default)]
    data: Option<String>,
    /// 非流式合成时为音频文件 URL（有效期 24 小时）。
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    #[serde(default)]
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiPart {
    #[serde(default)]
    inline_data: Option<GeminiInlineData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiInlineData {
    #[serde(default)]
    mime_type: String,
    data: String,
}

#[derive(Debug, Serialize)]
struct AiLogEntry<'a> {
    timestamp_ms: u128,
    action: &'a str,
    provider: &'a str,
    model: &'a str,
    endpoint: &'a str,
    success: bool,
    message: &'a str,
}

#[derive(Debug, Deserialize)]
struct RawAiLogEntry {
    timestamp_ms: u128,
    action: String,
    provider: String,
    model: String,
    endpoint: String,
    success: bool,
    message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiLogOutput {
    pub timestamp_ms: u128,
    pub action: String,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub success: bool,
    pub message: String,
}

#[tauri::command]
pub fn get_ai_config() -> AiConfig {
    config::load_config()
}

#[tauri::command]
pub fn set_ai_config(config: AiConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
pub fn get_ai_image_config() -> AiProviderConfig {
    config::load_image_config()
}

#[tauri::command]
pub fn set_ai_image_config(config: AiProviderConfig) -> Result<(), String> {
    config::save_image_config(&config)
}

#[tauri::command]
pub fn get_ai_tts_config() -> AiProviderConfig {
    config::load_tts_config()
}

#[tauri::command]
pub fn set_ai_tts_config(config: AiProviderConfig) -> Result<(), String> {
    config::save_tts_config(&config)
}

#[tauri::command]
pub fn list_ai_logs(limit: Option<usize>) -> Result<Vec<AiLogOutput>, String> {
    let limit = normalize_log_limit(limit);
    let lines = config::read_log_lines(limit)?;
    Ok(parse_ai_log_lines(lines))
}

#[tauri::command]
pub fn clear_ai_logs() -> Result<(), String> {
    config::clear_log()
}

#[tauri::command]
pub fn get_ai_log_path() -> Result<String, String> {
    config::log_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ai_generate_image(
    app_handle: AppHandle,
    prompt: String,
    model: String,
    reference_image_path: Option<String>,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_image_config();
    validate_provider_config_basics(&cfg, "图片")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择图片生成模型".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("图片生成描述为空".to_string());
    }

    // 可选参考图（图生图）：读成 (mime, base64)，仅部分 provider 适配，其余忽略。
    let reference = match reference_image_path {
        Some(path) if !path.trim().is_empty() => Some(read_image_as_base64(path.trim())?),
        _ => None,
    };

    match cfg.provider.trim() {
        "openai" | "custom" | "zhipu" | "siliconflow" | "midjourney" => {
            generate_openai_compatible_image(&cfg, model, &prompt, reference.as_ref()).await
        }
        "volcengine" => {
            // 火山引擎 Seedream 图生图需要公网 URL，不支持本地 base64，静默忽略参考图。
            // 角色一致性依赖提示词中已包含的详细外观描述（buildSpritePrompt）。
            generate_openai_compatible_image(&cfg, model, &prompt, None).await
        }
        "aliyun" => generate_dashscope_image(&app_handle, &cfg, model, &prompt).await,
        "gemini" => generate_gemini_image(&cfg, model, &prompt, reference.as_ref()).await,
        "sd-webui" => generate_sd_webui_image(&cfg, &prompt).await,
        "stability" => Err("Stability AI 图片接口需要 multipart/form-data；当前客户端尚未启用该格式，请先通过自定义 OpenAI 兼容网关接入。".to_string()),
        "baidu" => Err("百度千帆/文心一格图片接口需要 Access Token 获取流程；当前配置不足以直连。请使用 OpenAI 兼容网关或后续补充 OAuth 配置。".to_string()),
        "tencent" => Err("腾讯混元图像接口需要 TC3 签名参数；当前配置不足以直连。请使用 OpenAI 兼容网关或后续补充 SecretId/SecretKey/Region 配置。".to_string()),
        "minimax" => Err("MiniMax 图片接口是原生 /v1/image_generation 协议，不是 OpenAI /v1/images/generations；当前客户端尚未适配原生请求体，请先通过 OpenAI 兼容网关接入。".to_string()),
        "replicate" | "fal" => Err("Replicate/fal.ai 图片接口是任务式 API，且不同模型路由不同；当前模型字段不足以稳定直连。请先通过自定义网关接入。".to_string()),
        "comfyui" => Err("ComfyUI 需要完整 workflow JSON 才能生成图片；当前 UI 只有模型选择，尚未适配 workflow 提交。".to_string()),
        other => Err(format!("当前暂未适配 {other} 图片生成接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。")),
    }
}

#[tauri::command]
pub async fn ai_generate_tts(
    text: String,
    voice_prompt: String,
    model: String,
    format: String,
) -> Result<GeneratedMedia, String> {
    let cfg = config::load_tts_config();
    validate_provider_config_basics(&cfg, "音频")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择音频生成模型".to_string());
    }
    if text.trim().is_empty() {
        return Err("语音文本为空".to_string());
    }

    let response_format = normalize_audio_format(&format);
    match cfg.provider.trim() {
        "openai" | "custom" => {
            generate_openai_compatible_tts(&cfg, model, &text, &voice_prompt, response_format).await
        }
        "elevenlabs" => generate_elevenlabs_tts(&cfg, model, &text, &voice_prompt, response_format).await,
        "aliyun" => generate_dashscope_tts(&cfg, model, &text, &voice_prompt, response_format).await,
        "gemini" => Err("Gemini TTS 当前返回格式需要解析 generateContent 的 inline audio；此客户端尚未适配，请先使用 OpenAI 兼容音频网关。".to_string()),
        "azure" => Err("Azure Speech 需要 region endpoint、SSML voice 和 Ocp-Apim-Subscription-Key；当前配置不足以稳定直连。请使用自定义网关或后续补充 Azure 专用字段。".to_string()),
        "volcengine" => Err("火山引擎语音接口需要 AppID/Cluster/签名等专用参数；当前配置不足以直连。".to_string()),
        "tencent" => Err("腾讯云 TTS 需要 TC3 签名参数；当前配置不足以直连。".to_string()),
        "baidu" => Err("百度语音合成需要 Access Token 获取流程；当前配置不足以直连。".to_string()),
        "minimax" => Err("MiniMax TTS 需要 group_id 和 voice_id 等专用字段；当前 UI 暂未配置这些参数。".to_string()),
        "xunfei" => Err("讯飞 TTS 需要 WebSocket 鉴权签名参数；当前配置不足以直连。".to_string()),
        "edge-tts" => Err("Edge TTS 是本地/命令行方案，当前 Tauri 后端尚未集成 edge-tts 执行器。".to_string()),
        other => Err(format!("当前暂未适配 {other} 音频生成接口，请使用 OpenAI 兼容 Base URL 或选择已适配供应商。")),
    }
}

#[tauri::command]
pub async fn validate_ai_config(config: AiConfig) -> Result<AiValidationResult, String> {
    validate_config_basics(&config)?;

    let endpoint = effective_endpoint(&config);
    let request = ChatRequest::new(vec![ChatMessage::user("Reply with exactly OK.")]);
    let client = build_client(&config);

    match client.exec_chat(&config.model, request, None).await {
        Ok(response) => {
            let message = response
                .first_text()
                .map(|text| format!("连接成功，模型返回：{}", text.trim()))
                .unwrap_or_else(|| "连接成功，模型已响应。".to_string());
            log_ai_event("validate", &config, &endpoint, true, &message);
            Ok(AiValidationResult {
                ok: true,
                provider: config.provider,
                model: config.model,
                endpoint,
                message,
            })
        }
        Err(err) => {
            let message = err.to_string();
            log_ai_event("validate", &config, &endpoint, false, &message);
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    request_id: String,
    messages: Vec<AiMessageInput>,
    character_context: Option<String>,
) -> Result<(), String> {
    let cfg = config::load_config();
    validate_config_basics(&cfg)?;

    let mut chat_messages: Vec<ChatMessage> = Vec::new();
    let mut sys_text = config::default_system_prompt();

    if let Some(ref ctx) = character_context {
        if !ctx.is_empty() {
            if !sys_text.is_empty() {
                sys_text.push_str("\n\n");
            }
            sys_text.push_str("## 当前项目的角色设定\n");
            sys_text.push_str(ctx);
        }
    }

    if !sys_text.is_empty() {
        chat_messages.push(ChatMessage::system(&sys_text));
    }
    for m in messages {
        let msg = match m.role.as_str() {
            "user" => ChatMessage::user(m.content),
            "assistant" => ChatMessage::assistant(m.content),
            "system" => ChatMessage::system(m.content),
            _ => ChatMessage::user(m.content),
        };
        chat_messages.push(msg);
    }

    let request = ChatRequest::new(chat_messages);
    let client = build_client(&cfg);
    let model = cfg.model.clone();
    let endpoint = effective_endpoint(&cfg);
    let event_name = format!("ai-chat-{request_id}");

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app_handle.emit(&event_name, AiStreamEvent::Start);
        match client.exec_chat_stream(&model, request, None).await {
            Ok(chat_res) => {
                let mut stream = chat_res.stream;
                while let Some(event) = stream.next().await {
                    match event {
                        Ok(ChatStreamEvent::Chunk(StreamChunk { content })) => {
                            let _ = app_handle.emit(&event_name, AiStreamEvent::Chunk { content });
                        }
                        Ok(ChatStreamEvent::End(_)) => break,
                        Ok(_) => {}
                        Err(e) => {
                            let message = e.to_string();
                            log_ai_event("chat_stream", &cfg, &endpoint, false, &message);
                            let _ = app_handle.emit(&event_name, AiStreamEvent::Error { message });
                            return;
                        }
                    }
                }
                log_ai_event("chat_stream", &cfg, &endpoint, true, "stream completed");
                let _ = app_handle.emit(&event_name, AiStreamEvent::Done);
            }
            Err(e) => {
                let message = e.to_string();
                log_ai_event("chat_stream", &cfg, &endpoint, false, &message);
                let _ = app_handle.emit(&event_name, AiStreamEvent::Error { message });
            }
        }
    });

    Ok(())
}

/// Convert frontend message inputs into genai chat messages, replaying tool
/// calls (assistant) and tool responses (tool role) so multi-step loops keep
/// full provider-side context.
fn to_chat_messages(messages: Vec<AiMessageInput>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => out.push(ChatMessage::system(m.content)),
            "tool" => {
                let call_id = m.tool_call_id.unwrap_or_default();
                out.push(ToolResponse::new(call_id, m.content).into());
            }
            "assistant" => {
                if let Some(calls) = m.tool_calls {
                    if !calls.is_empty() {
                        let tool_calls: Vec<ToolCall> = calls
                            .into_iter()
                            .map(|c| ToolCall {
                                call_id: c.id,
                                fn_name: c.name,
                                fn_arguments: c.arguments,
                                thought_signatures: None,
                            })
                            .collect();
                        out.push(tool_calls.into());
                        continue;
                    }
                }
                out.push(ChatMessage::assistant(m.content));
            }
            _ => out.push(ChatMessage::user(m.content)),
        }
    }
    out
}

/// Single non-streaming turn used by the multi-step agent loop. Returns either
/// the model's tool calls (to be executed by the frontend) or its final text.
#[tauri::command]
pub async fn ai_chat_turn(
    messages: Vec<AiMessageInput>,
    tools: Vec<ToolDef>,
    character_context: Option<String>,
) -> Result<AiTurnResult, String> {
    let cfg = config::load_config();
    validate_config_basics(&cfg)?;

    let mut chat_messages: Vec<ChatMessage> = Vec::new();
    if let Some(ctx) = character_context {
        if !ctx.trim().is_empty() {
            chat_messages.push(ChatMessage::system(format!(
                "## 当前项目的角色设定\n{ctx}"
            )));
        }
    }
    chat_messages.extend(to_chat_messages(messages));

    let mut request = ChatRequest::new(chat_messages);
    if !tools.is_empty() {
        let genai_tools: Vec<Tool> = tools
            .into_iter()
            .map(|t| Tool::new(t.name).with_description(t.description).with_schema(t.parameters))
            .collect();
        request = request.with_tools(genai_tools);
    }

    let client = build_client(&cfg);
    let endpoint = effective_endpoint(&cfg);

    match client.exec_chat(&cfg.model, request, None).await {
        Ok(response) => {
            let text = response.first_text().map(|t| t.to_string());
            let tool_calls = response
                .into_tool_calls()
                .into_iter()
                .map(|c| AiToolCall {
                    id: c.call_id,
                    name: c.fn_name,
                    arguments: c.fn_arguments,
                })
                .collect();
            log_ai_event("chat_turn", &cfg, &endpoint, true, "turn completed");
            Ok(AiTurnResult { text, tool_calls })
        }
        Err(err) => {
            let message = err.to_string();
            log_ai_event("chat_turn", &cfg, &endpoint, false, &message);
            Err(message)
        }
    }
}

fn build_client(cfg: &AiConfig) -> Client {
    let api_key = cfg.api_key.clone();
    let base_url = cfg.base_url.clone();
    let provider = cfg.provider.clone();

    let resolver = ServiceTargetResolver::from_resolver_fn(
        move |service_target: ServiceTarget| -> Result<ServiceTarget, genai::resolver::Error> {
            let ServiceTarget {
                mut endpoint,
                mut auth,
                model,
            } = service_target;

            let (forced_kind, default_endpoint) = match provider.as_str() {
                "openai" => (
                    Some(AdapterKind::OpenAI),
                    Some("https://api.openai.com/v1/"),
                ),
                "anthropic" => (
                    Some(AdapterKind::Anthropic),
                    Some("https://api.anthropic.com/v1/"),
                ),
                "gemini" => (
                    Some(AdapterKind::Gemini),
                    Some("https://generativelanguage.googleapis.com/v1beta/"),
                ),
                "deepseek" => (
                    Some(AdapterKind::DeepSeek),
                    Some("https://api.deepseek.com/v1/"),
                ),
                "groq" => (
                    Some(AdapterKind::Groq),
                    Some("https://api.groq.com/openai/v1/"),
                ),
                "xai" => (Some(AdapterKind::Xai), Some("https://api.x.ai/v1/")),
                "ollama" => (
                    Some(AdapterKind::Ollama),
                    Some("http://localhost:11434/v1/"),
                ),
                "cohere" => (
                    Some(AdapterKind::Cohere),
                    Some("https://api.cohere.com/v2/"),
                ),
                "custom" => (Some(AdapterKind::OpenAI), None),
                _ => (None, None),
            };

            let model = if let Some(kind) = forced_kind {
                ModelIden::new(kind, model.model_name)
            } else {
                model
            };

            if !base_url.is_empty() {
                endpoint = Endpoint::from_owned(base_url.clone());
            } else if let Some(default) = default_endpoint {
                endpoint = Endpoint::from_static(default);
            }

            if !api_key.is_empty() {
                auth = AuthData::from_single(api_key.clone());
            }

            Ok(ServiceTarget {
                endpoint,
                auth,
                model,
            })
        },
    );

    Client::builder()
        .with_service_target_resolver(resolver)
        .build()
}

fn validate_config_basics(cfg: &AiConfig) -> Result<(), String> {
    let provider = cfg.provider.trim();
    if provider.is_empty() {
        return Err("尚未选择 AI 供应商".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("尚未配置模型名称".into());
    }
    if provider == "custom" && cfg.base_url.trim().is_empty() {
        return Err("自定义 OpenAI 兼容接口需要填写 Base URL".into());
    }
    if cfg.api_key.trim().is_empty() && provider != "ollama" && provider != "custom" {
        return Err("尚未配置 API Key，请先在 AI 设置中填写".into());
    }
    Ok(())
}

fn effective_endpoint(cfg: &AiConfig) -> String {
    if !cfg.base_url.trim().is_empty() {
        return cfg.base_url.trim().to_string();
    }
    match cfg.provider.as_str() {
        "openai" => "https://api.openai.com/v1/".to_string(),
        "anthropic" => "https://api.anthropic.com/v1/".to_string(),
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/".to_string(),
        "deepseek" => "https://api.deepseek.com/v1/".to_string(),
        "groq" => "https://api.groq.com/openai/v1/".to_string(),
        "xai" => "https://api.x.ai/v1/".to_string(),
        "ollama" => "http://localhost:11434/v1/".to_string(),
        "cohere" => "https://api.cohere.com/v2/".to_string(),
        "custom" => String::new(),
        _ => String::new(),
    }
}

fn media_endpoint(cfg: &AiProviderConfig, path: &str) -> String {
    let configured_base = cfg.base_url.trim();
    let should_use_configured_base =
        !configured_base.is_empty() && !is_placeholder_base_url(configured_base);
    let base = if should_use_configured_base {
        cfg.base_url.trim().trim_end_matches('/').to_string()
    } else {
        match cfg.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "volcengine" => "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            "zhipu" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
            "siliconflow" => "https://api.siliconflow.cn/v1".to_string(),
            _ => String::new(),
        }
    };
    if base.is_empty() {
        path.to_string()
    } else if base.ends_with(path) {
        base
    } else {
        format!("{base}/{path}")
    }
}

fn is_placeholder_base_url(value: &str) -> bool {
    value.to_ascii_lowercase().contains("api.example.com")
}

/// Read a local image file into `(mime_type, base64_without_prefix)` for use as
/// an image-to-image reference. Used by providers that support a reference image.
fn read_image_as_base64(path: &str) -> Result<(String, String), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取参考图失败 {path}: {e}"))?;
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((mime.to_string(), b64))
}

async fn generate_openai_compatible_image(
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
    reference: Option<&(String, String)>,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "images/generations");
    let body = if is_seedream_model(model) {
        let mut body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "size": "2K",
            "response_format": "url",
            "stream": false,
            "watermark": false,
            "sequential_image_generation": "disabled"
        });
        // Seedream 4.x 支持图生图：image 字段传参考图。
        // 火山引擎要求纯 base64（不带 data: 前缀），而非 data URI。
        if let Some((_mime, b64)) = reference {
            body["image"] = serde_json::json!(b64);
        }
        body
    } else {
        // 非 Seedream 的 OpenAI 兼容图片接口（DALL·E/gpt-image 协议不同）暂忽略参考图。
        serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json"
        })
    };
    let text = post_json_text(cfg, &endpoint, body, "图片生成").await?;
    parse_openai_image_response(cfg, model, &endpoint, &text).await
}

async fn generate_dashscope_image(
    app_handle: &AppHandle,
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = dashscope_endpoint(cfg, "services/aigc/text2image/image-synthesis");
    let body = serde_json::json!({
        "model": model,
        "input": {
            "prompt": prompt
        },
        "parameters": {
            "size": "1024*1024",
            "n": 1
        }
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化阿里云图片生成请求失败: {e}"))?;
    let client = reqwest::Client::new();
    let response = client
        .post(&endpoint)
        .bearer_auth(cfg.api_key.trim())
        .header("Content-Type", "application/json")
        .header("X-DashScope-Async", "enable")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("阿里云图片生成请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取阿里云图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, model, &endpoint, false, &text);
        return Err(format!("阿里云图片生成失败 ({status}): {text}"));
    }
    let parsed: DashScopeTaskCreateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析阿里云图片任务响应失败: {e}; 响应: {text}"))?;
    let task_id = parsed
        .output
        .task_id
        .ok_or_else(|| format!("阿里云图片任务响应缺少 task_id: {text}"))?;
    let task_endpoint = dashscope_endpoint(cfg, &format!("tasks/{task_id}"));
    emit_media_generation_progress(
        app_handle,
        cfg,
        model,
        "submitted",
        0,
        36,
        "阿里云图片任务已提交，等待生成结果...",
    );
    for attempt in 1..=36 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        emit_media_generation_progress(
            app_handle,
            cfg,
            model,
            "polling",
            attempt,
            36,
            "正在查询阿里云图片生成状态...",
        );
        let poll = client
            .get(&task_endpoint)
            .bearer_auth(cfg.api_key.trim())
            .send()
            .await
            .map_err(|e| format!("查询阿里云图片任务失败: {e}"))?;
        let status = poll.status();
        let text = poll.text().await.map_err(|e| format!("读取阿里云图片任务响应失败: {e}"))?;
        if !status.is_success() {
            log_provider_event("image_generate", cfg, model, &task_endpoint, false, &text);
            return Err(format!("查询阿里云图片任务失败 ({status}): {text}"));
        }
        let parsed: DashScopeTaskCreateResponse = serde_json::from_str(&text)
            .map_err(|e| format!("解析阿里云图片任务状态失败: {e}; 响应: {text}"))?;
        match parsed.output.task_status.as_deref() {
            Some("SUCCEEDED") => {
                emit_media_generation_progress(
                    app_handle,
                    cfg,
                    model,
                    "succeeded",
                    attempt,
                    36,
                    "阿里云图片生成完成，正在下载结果...",
                );
                let url = parsed
                    .output
                    .results
                    .into_iter()
                    .find_map(|item| item.url)
                    .ok_or_else(|| format!("阿里云图片任务完成但缺少图片 URL: {text}"))?;
                return download_generated_media(cfg, model, &task_endpoint, &url, "png", "image_generate").await;
            }
            Some("FAILED") | Some("CANCELED") | Some("UNKNOWN") => {
                emit_media_generation_progress(
                    app_handle,
                    cfg,
                    model,
                    "failed",
                    attempt,
                    36,
                    "阿里云图片任务失败。",
                );
                log_provider_event("image_generate", cfg, model, &task_endpoint, false, &text);
                return Err(format!("阿里云图片任务失败: {text}"));
            }
            _ => {}
        }
    }
    emit_media_generation_progress(
        app_handle,
        cfg,
        model,
        "timeout",
        36,
        36,
        "阿里云图片任务超时。",
    );
    Err("阿里云图片任务超时，请稍后查看任务或重试。".to_string())
}

fn emit_media_generation_progress(
    app_handle: &AppHandle,
    cfg: &AiProviderConfig,
    model: &str,
    phase: &str,
    attempt: u8,
    total_attempts: u8,
    message: &str,
) {
    let _ = app_handle.emit(
        "ai-media-generation-progress",
        AiMediaGenerationProgress {
            provider: cfg.provider.clone(),
            model: model.to_string(),
            phase: phase.to_string(),
            attempt,
            total_attempts,
            message: message.to_string(),
        },
    );
}

async fn generate_gemini_image(
    cfg: &AiProviderConfig,
    model: &str,
    prompt: &str,
    reference: Option<&(String, String)>,
) -> Result<GeneratedMedia, String> {
    let endpoint = gemini_endpoint(cfg, model, "generateContent");
    // 有参考图时走图生图：parts 追加 inline_data。
    let parts = match reference {
        Some((mime, b64)) => serde_json::json!([
            { "inline_data": { "mime_type": mime, "data": b64 } },
            { "text": prompt }
        ]),
        None => serde_json::json!([{ "text": prompt }]),
    };
    let body = serde_json::json!({
        "contents": [{
            "parts": parts
        }]
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化 Gemini 图片生成请求失败: {e}"))?;
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Gemini 图片生成请求失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取 Gemini 图片生成响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("image_generate", cfg, model, &endpoint, false, &text);
        return Err(format!("Gemini 图片生成失败 ({status}): {text}"));
    }
    let parsed: GeminiGenerateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Gemini 图片生成响应失败: {e}; 响应: {text}"))?;
    for candidate in parsed.candidates {
        if let Some(content) = candidate.content {
            for part in content.parts {
                if let Some(inline) = part.inline_data {
                    let extension = extension_from_mime(&inline.mime_type, "png");
                    log_provider_event("image_generate", cfg, model, &endpoint, true, "image generated");
                    return Ok(GeneratedMedia {
                        base64_data: inline.data,
                        extension,
                    });
                }
            }
        }
    }
    Err("Gemini 图片生成响应中没有 inline image 数据".to_string())
}

async fn generate_sd_webui_image(
    cfg: &AiProviderConfig,
    prompt: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "sdapi/v1/txt2img");
    let body = serde_json::json!({
        "prompt": prompt,
        "steps": 28,
        "width": 1024,
        "height": 1024,
        "batch_size": 1,
        "n_iter": 1
    });
    let text = post_json_text(cfg, &endpoint, body, "Stable Diffusion WebUI 图片生成").await?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Stable Diffusion WebUI 响应失败: {e}; 响应: {text}"))?;
    let b64 = parsed
        .get("images")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Stable Diffusion WebUI 响应中没有 images[0]: {text}"))?;
    log_provider_event("image_generate", cfg, cfg.model.trim(), &endpoint, true, "image generated");
    Ok(GeneratedMedia {
        base64_data: strip_data_url_prefix(b64).to_string(),
        extension: "png".to_string(),
    })
}

async fn generate_openai_compatible_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let endpoint = media_endpoint(cfg, "audio/speech");
    let voice = openai_voice_from_prompt(voice_prompt);
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": response_format
    });
    post_audio_bytes(cfg, model, &endpoint, body, response_format, "tts_generate").await
}

async fn generate_elevenlabs_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    let voice_id = elevenlabs_voice_id(voice_prompt);
    let endpoint = if !cfg.base_url.trim().is_empty() {
        let base = cfg.base_url.trim().trim_end_matches('/');
        if base.contains("/text-to-speech/") {
            base.to_string()
        } else {
            format!("{base}/v1/text-to-speech/{voice_id}")
        }
    } else {
        format!("https://api.elevenlabs.io/v1/text-to-speech/{voice_id}")
    };
    let output_format = match response_format {
        "mp3" => "mp3_44100_128",
        "pcm" => "pcm_44100",
        "wav" => "pcm_44100",
        _ => "mp3_44100_128",
    };
    let body = serde_json::json!({
        "text": text,
        "model_id": model,
        "output_format": output_format
    });
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化 ElevenLabs 请求失败: {e}"))?;
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("xi-api-key", cfg.api_key.trim())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs 音频生成请求失败: {e}"))?;
    response_to_generated_media(response, cfg, model, &endpoint, response_format, "tts_generate").await
}

async fn generate_dashscope_tts(
    cfg: &AiProviderConfig,
    model: &str,
    text: &str,
    voice_prompt: &str,
    response_format: &str,
) -> Result<GeneratedMedia, String> {
    // CosyVoice 非实时 HTTP 接口：POST .../SpeechSynthesizer，参数全部在 input 内，
    // 非流式响应为 JSON，音频在 output.audio.url（24h 有效），需再下载。
    let endpoint = dashscope_endpoint(cfg, "services/audio/tts/SpeechSynthesizer");
    let voice = dashscope_voice_from_prompt(voice_prompt);
    let body = serde_json::json!({
        "model": model,
        "input": {
            "text": text,
            "voice": voice,
            "format": response_format
        }
    });
    let response_text = post_json_text(cfg, &endpoint, body, "阿里云语音合成").await?;
    let parsed: DashScopeTtsResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("解析阿里云语音合成响应失败: {e}; 响应: {response_text}"))?;
    let audio = parsed
        .output
        .and_then(|o| o.audio)
        .ok_or_else(|| format!("阿里云语音合成响应缺少 audio 字段: {response_text}"))?;
    if let Some(data) = audio.data.filter(|d| !d.is_empty()) {
        log_provider_event("tts_generate", cfg, model, &endpoint, true, "audio generated");
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&data).to_string(),
            extension: response_format.to_string(),
        });
    }
    if let Some(url) = audio.url.filter(|u| !u.is_empty()) {
        return download_generated_media(cfg, model, &endpoint, &url, response_format, "tts_generate").await;
    }
    Err(format!("阿里云语音合成响应既无 data 也无 url: {response_text}"))
}

async fn post_json_text(
    cfg: &AiProviderConfig,
    endpoint: &str,
    body: serde_json::Value,
    action_label: &str,
) -> Result<String, String> {
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化{action_label}请求失败: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建{action_label}HTTP客户端失败: {e}"))?;
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| {
            let message = format!("{action_label}请求失败: {e}");
            log_provider_event("media_generate", cfg, cfg.model.trim(), endpoint, false, &message);
            message
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取{action_label}响应失败: {e}"))?;
    if !status.is_success() {
        log_provider_event("media_generate", cfg, cfg.model.trim(), endpoint, false, &text);
        return Err(format!("{action_label}失败 ({status}): {text}"));
    }
    Ok(text)
}

async fn post_audio_bytes(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    body: serde_json::Value,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let body = serde_json::to_string(&body).map_err(|e| format!("序列化音频生成请求失败: {e}"))?;
    let mut request = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body);
    if !cfg.api_key.trim().is_empty() {
        request = request.bearer_auth(cfg.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("音频生成请求失败: {e}"))?;
    response_to_generated_media(response, cfg, model, endpoint, extension, action).await
}

async fn response_to_generated_media(
    response: reqwest::Response,
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        log_provider_event(action, cfg, model, endpoint, false, &text);
        return Err(format!("音频生成失败 ({status}): {text}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取音频生成响应失败: {e}"))?;
    log_provider_event(action, cfg, model, endpoint, true, "audio generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}

async fn parse_openai_image_response(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    text: &str,
) -> Result<GeneratedMedia, String> {
    let parsed: OpenAiImageResponse = serde_json::from_str(text)
        .map_err(|e| format!("解析图片生成响应失败: {e}; 响应: {text}"))?;
    let item = parsed
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "图片生成响应中没有图片数据".to_string())?;
    if let Some(b64) = item.b64_json {
        log_provider_event("image_generate", cfg, model, endpoint, true, "image generated");
        return Ok(GeneratedMedia {
            base64_data: strip_data_url_prefix(&b64).to_string(),
            extension: "png".to_string(),
        });
    }
    if let Some(url) = item.url {
        return download_generated_media(cfg, model, endpoint, &url, "png", "image_generate").await;
    }
    Err("图片生成响应中没有 b64_json 或 url".to_string())
}

async fn download_generated_media(
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    url: &str,
    extension: &str,
    action: &str,
) -> Result<GeneratedMedia, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载生成媒体失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取生成媒体失败: {e}"))?;
    log_provider_event(action, cfg, model, endpoint, true, "media generated");
    Ok(GeneratedMedia {
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
        extension: extension.to_string(),
    })
}

fn dashscope_endpoint(cfg: &AiProviderConfig, path: &str) -> String {
    let base = if cfg.base_url.trim().is_empty() {
        "https://dashscope.aliyuncs.com/api/v1".to_string()
    } else {
        cfg.base_url.trim().trim_end_matches('/').to_string()
    };
    if base.ends_with(path) {
        base
    } else {
        format!("{base}/{path}")
    }
}

fn gemini_endpoint(_cfg: &AiProviderConfig, model: &str, action: &str) -> String {
    let base = if _cfg.base_url.trim().is_empty() {
        "https://generativelanguage.googleapis.com/v1beta".to_string()
    } else {
        _cfg.base_url.trim().trim_end_matches('/').to_string()
    };
    format!("{base}/models/{model}:{action}")
}

fn strip_data_url_prefix(value: &str) -> &str {
    value.split_once(',').map(|(_, data)| data).unwrap_or(value)
}

fn extension_from_mime(mime_type: &str, fallback: &str) -> String {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => fallback,
    }
    .to_string()
}

fn is_seedream_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("seedream")
}

fn validate_provider_config_basics(cfg: &AiProviderConfig, capability: &str) -> Result<(), String> {
    if cfg.provider.trim().is_empty() {
        return Err(format!("尚未选择{capability} AI 供应商"));
    }
    if cfg.model.trim().is_empty() {
        return Err(format!("尚未配置{capability}模型"));
    }
    if cfg.provider == "custom" && is_placeholder_base_url(&cfg.base_url) {
        return Err(format!("自定义{capability} Base URL 仍是示例地址，请填写真实接口地址"));
    }
    if cfg.api_key.trim().is_empty()
        && cfg.provider != "sd-webui"
        && cfg.provider != "comfyui"
        && cfg.provider != "edge-tts"
    {
        return Err(format!("尚未配置{capability} API Key"));
    }
    Ok(())
}

fn normalize_audio_format(value: &str) -> &'static str {
    match value.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "opus" => "opus",
        "aac" => "aac",
        "flac" => "flac",
        "wav" => "wav",
        "pcm" => "pcm",
        _ => "mp3",
    }
}

fn openai_voice_from_prompt(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for voice in ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] {
        if lower.contains(voice) {
            return voice.to_string();
        }
    }
    "alloy".to_string()
}

fn elevenlabs_voice_id(value: &str) -> String {
    for token in value.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '，' || c == '；') {
        let token = token.trim();
        if token.len() >= 16 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return token.to_string();
        }
    }
    "21m00Tcm4TlvDq8ikWAM".to_string()
}

fn dashscope_voice_from_prompt(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    for voice in [
        "longxiaochun",
        "longxiaoxia",
        "longxiaobai",
        "longlaotie",
        "loongstella",
        "loongbella",
        "loongnina",
        "zhichu",
        "zhiting",
        "zhixiang",
        "zhiwei",
        "zhimiao",
        "zhiru",
    ] {
        if lower.contains(voice) {
            return voice.to_string();
        }
    }
    "longxiaochun".to_string()
}

fn log_provider_event(
    action: &str,
    cfg: &AiProviderConfig,
    model: &str,
    endpoint: &str,
    success: bool,
    message: &str,
) {
    let chat_cfg = AiConfig {
        provider: cfg.provider.clone(),
        model: model.to_string(),
        api_key: cfg.api_key.clone(),
        base_url: cfg.base_url.clone(),
    };
    log_ai_event(action, &chat_cfg, endpoint, success, message);
}

fn log_ai_event(action: &str, cfg: &AiConfig, endpoint: &str, success: bool, message: &str) {
    let redacted_endpoint = sanitize_log_field(&redact_known_secret(endpoint, &cfg.api_key));
    let redacted_message = sanitize_log_field(&redact_known_secret(message, &cfg.api_key));
    let entry = AiLogEntry {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        action,
        provider: &cfg.provider,
        model: &cfg.model,
        endpoint: &redacted_endpoint,
        success,
        message: &redacted_message,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = config::append_log_line(&line);
    }
}

fn normalize_log_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LOG_LIMIT).min(MAX_LOG_LIMIT)
}

fn parse_ai_log_lines(lines: Vec<String>) -> Vec<AiLogOutput> {
    lines
        .into_iter()
        .filter_map(|line| parse_ai_log_line(&line))
        .collect()
}

fn parse_ai_log_line(line: &str) -> Option<AiLogOutput> {
    let raw = serde_json::from_str::<RawAiLogEntry>(line).ok()?;
    Some(AiLogOutput {
        timestamp_ms: raw.timestamp_ms,
        action: sanitize_log_field(&raw.action),
        provider: sanitize_log_field(&raw.provider),
        model: sanitize_log_field(&raw.model),
        endpoint: sanitize_log_field(&raw.endpoint),
        success: raw.success,
        message: sanitize_log_field(&raw.message),
    })
}

fn sanitize_log_field(value: &str) -> String {
    truncate_log_field(&redact_common_secrets(value))
}

fn redact_known_secret(value: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.is_empty() {
        value.to_string()
    } else {
        value.replace(secret, "[REDACTED]")
    }
}

fn redact_common_secrets(value: &str) -> String {
    let mut output = value.to_string();
    for marker in [
        "authorization=bearer ",
        "api_key=",
        "apikey=",
        "access_token=",
        "token=",
        "key=",
        "authorization=",
        "bearer ",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
}

fn redact_after_marker(value: &str, marker: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut cursor = 0;
    let mut redacted = String::new();

    while let Some(relative_start) = lower[cursor..].find(marker) {
        let start = cursor + relative_start;
        let marker_end = start + marker.len();
        let mut end = marker_end;
        while end < value.len() {
            let ch = value.as_bytes()[end] as char;
            if ch == '&' || ch == '"' || ch == '\'' || ch.is_ascii_whitespace() {
                break;
            }
            end += 1;
        }

        redacted.push_str(&value[cursor..marker_end]);
        redacted.push_str("[REDACTED]");
        cursor = end;
    }

    if cursor == 0 {
        value.to_string()
    } else {
        redacted.push_str(&value[cursor..]);
        redacted
    }
}

fn truncate_log_field(value: &str) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(MAX_LOG_FIELD_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

// ── Batch TTS ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTtsItem {
    pub voice_card_id: String,
    pub text: String,
    pub voice_prompt: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchTtsProgress {
    pub voice_card_id: String,
    pub index: usize,
    pub total: usize,
    pub status: String, // "generating" | "done" | "error"
    pub message: String,
    /// Name of the generated audio file on success.
    pub asset_name: Option<String>,
}

/// Generate TTS audio for multiple voice cards in sequence, emitting progress
/// events via `batch-tts-progress` so the UI can show per-item status.
#[tauri::command]
pub async fn generate_batch_tts(
    app_handle: tauri::AppHandle,
    project_path: String,
    items: Vec<BatchTtsItem>,
    model: String,
    format: String,
) -> Result<Vec<BatchTtsProgress>, String> {
    let cfg = config::load_tts_config();
    validate_provider_config_basics(&cfg, "音频")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("尚未选择音频生成模型".to_string());
    }

    let total = items.len();
    let mut results: Vec<BatchTtsProgress> = Vec::with_capacity(total);
    let response_format = normalize_audio_format(&format);

    for (index, item) in items.iter().enumerate() {
        let progress_start = BatchTtsProgress {
            voice_card_id: item.voice_card_id.clone(),
            index,
            total,
            status: "generating".to_string(),
            message: format!("正在生成 {}/{}...", index + 1, total),
            asset_name: None,
        };
        let _ = app_handle.emit("batch-tts-progress", &progress_start);

        let gen_result = match cfg.provider.trim() {
            "openai" | "custom" => {
                generate_openai_compatible_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            "elevenlabs" => {
                generate_elevenlabs_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            "aliyun" => {
                generate_dashscope_tts(
                    &cfg, model, &item.text, &item.voice_prompt, response_format,
                ).await
            }
            other => Err(format!("批量生成暂不支持 {other}，请使用 Amazon 兼容或已适配供应商。")),
        };

        match gen_result {
            Ok(media) => {
                // Save the audio file to disk
                let stem = format!("vo_batch_{}", item.voice_card_id);
                let filename = format!("{}.{}", stem, response_format);
                let save = crate::assets::commands::save_generated_asset(
                    project_path.clone(),
                    "vocal".to_string(),
                    filename.clone(),
                    media.base64_data.clone(),
                );
                let asset_name = match save {
                    Ok(info) => info.name,
                    Err(e) => {
                        let err_progress = BatchTtsProgress {
                            voice_card_id: item.voice_card_id.clone(),
                            index,
                            total,
                            status: "error".to_string(),
                            message: format!("保存音频文件失败: {e}"),
                            asset_name: None,
                        };
                        let _ = app_handle.emit("batch-tts-progress", &err_progress);
                        results.push(err_progress);
                        continue;
                    }
                };

                // Update VoiceAssetCard
                if let Ok(mut asset_meta) =
                    crate::assets::commands::read_asset_metadata(&project_path)
                {
                    if let Some(card) = asset_meta.voice_cards.get_mut(&item.voice_card_id) {
                        card.voice_asset = Some(asset_name.clone());
                        // Update tags
                        let tag_key = format!("vocal/{}", card.target_stem);
                        let mut tags: Vec<String> =
                            asset_meta.tags.get(&tag_key).cloned().unwrap_or_default();
                        tags.retain(|t| !t.starts_with("status:"));
                        tags.push("status:done".to_string());
                        tags.retain(|t| !t.starts_with("source:"));
                        tags.push("source:ai".to_string());
                        asset_meta.tags.insert(tag_key, tags);
                        let _ = crate::assets::commands::write_asset_metadata(
                            &project_path,
                            &asset_meta,
                        );
                    }
                }

                let progress_done = BatchTtsProgress {
                    voice_card_id: item.voice_card_id.clone(),
                    index,
                    total,
                    status: "done".to_string(),
                    message: format!("完成 {}/{}: {}", index + 1, total, asset_name),
                    asset_name: Some(asset_name),
                };
                let _ = app_handle.emit("batch-tts-progress", &progress_done);
                results.push(progress_done);
            }
            Err(err) => {
                let progress_err = BatchTtsProgress {
                    voice_card_id: item.voice_card_id.clone(),
                    index,
                    total,
                    status: "error".to_string(),
                    message: format!("生成失败: {err}"),
                    asset_name: None,
                };
                let _ = app_handle.emit("batch-tts-progress", &progress_err);
                results.push(progress_err);
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
fn list_ai_logs_from_path(
    path: &PathBuf,
    limit: Option<usize>,
) -> Result<Vec<AiLogOutput>, String> {
    let limit = normalize_log_limit(limit);
    let lines = config::read_log_lines_at(path, limit)?;
    Ok(parse_ai_log_lines(lines))
}

#[cfg(test)]
fn clear_ai_logs_at(path: &PathBuf) -> Result<(), String> {
    config::clear_log_at(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ai_logs_can_list_and_clear_with_redaction() {
        let tmp = std::env::temp_dir().join("webgal_test_ai_logs.jsonl");
        let _ = fs::remove_file(&tmp);
        config::append_log_line_at(
            &tmp,
            r#"{"timestamp_ms":1,"action":"validate","provider":"openai","model":"gpt","endpoint":"https://example.test/v1?api_key=secret123","success":false,"message":"Authorization=Bearer secret123 token=abc"}"#,
        )
        .unwrap();
        config::append_log_line_at(
            &tmp,
            r#"{"timestamp_ms":2,"action":"chat_stream","provider":"openai","model":"gpt","endpoint":"https://example.test/v1","success":true,"message":"ok"}"#,
        )
        .unwrap();

        let logs = list_ai_logs_from_path(&tmp, Some(10)).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].timestamp_ms, 1);
        assert!(logs[0].endpoint.contains("[REDACTED]"));
        assert!(!logs[0].endpoint.contains("secret123"));
        assert!(!logs[0].message.contains("abc"));

        clear_ai_logs_at(&tmp).unwrap();
        assert!(!tmp.exists());
    }

    #[test]
    fn ai_log_list_honors_limit() {
        let tmp = std::env::temp_dir().join("webgal_test_ai_logs_limit.jsonl");
        let _ = fs::remove_file(&tmp);
        for timestamp_ms in 1..=3 {
            config::append_log_line_at(
                &tmp,
                &format!(
                    r#"{{"timestamp_ms":{timestamp_ms},"action":"validate","provider":"openai","model":"gpt","endpoint":"","success":true,"message":"ok"}}"#
                ),
            )
            .unwrap();
        }

        let logs = list_ai_logs_from_path(&tmp, Some(2)).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].timestamp_ms, 2);
        assert_eq!(logs[1].timestamp_ms, 3);
        let _ = fs::remove_file(&tmp);
    }
}
