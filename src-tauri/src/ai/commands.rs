use super::config::{self, AiConfig};
use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{ChatMessage, ChatRequest, ChatStreamEvent, StreamChunk};
use genai::resolver::{AuthData, Endpoint, ServiceTargetResolver};
use genai::{Client, ModelIden, ServiceTarget};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_LOG_LIMIT: usize = 500;
const DEFAULT_LOG_LIMIT: usize = 100;
const MAX_LOG_FIELD_CHARS: usize = 1000;

#[derive(Debug, Deserialize)]
pub struct AiMessageInput {
    pub role: String,
    pub content: String,
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
pub fn default_ai_system_prompt() -> String {
    config::default_system_prompt()
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
    let sys = cfg.system_prompt.trim();
    let mut sys_text = if !sys.is_empty() {
        sys.to_string()
    } else {
        String::new()
    };

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
