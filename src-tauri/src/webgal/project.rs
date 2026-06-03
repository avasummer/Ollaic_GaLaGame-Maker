use super::references;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;

/// WebGAL game/ subdirectory structure.
const GAME_DIRS: &[&str] = &[
    "animation",
    "background",
    "figure",
    "scene",
    "bgm",
    "sfx",
    "vocal",
    "video",
    "tex",
];

/// Metadata about a WebGAL project on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Absolute path to the project root (parent of game/).
    pub path: String,
    /// Config values from game/config.txt.
    pub config: HashMap<String, String>,
    /// Scene file names found in game/scene/.
    pub scenes: Vec<String>,
}

/// Information about a single scene file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub world_setting: String,
    pub writing_style: String,
    pub user_preferences: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub synopsis: String,
    pub description: String,
    pub cover_path: String,
    pub tags: Vec<String>,
    pub version: String,
    pub release_notes: String,
    pub last_export_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub path: String,
}

// ---------------------------------------------------------------------------
// config.txt helpers
// ---------------------------------------------------------------------------

fn parse_config(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        // Format: Key:Value;
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            let mut val = line[colon + 1..].trim().to_string();
            // Strip trailing semicolon
            if val.ends_with(';') {
                val.pop();
            }
            map.insert(key, val);
        }
    }
    map
}

fn serialize_config(config: &HashMap<String, String>) -> String {
    let mut lines: Vec<String> = config
        .iter()
        .map(|(k, v)| format!("{}:{};", k, v))
        .collect();
    lines.sort(); // deterministic output
    lines.push(String::new());
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Initialize a new WebGAL project at `base_dir/name/`.
/// Creates the full game/ directory structure and config.txt.
#[tauri::command]
pub fn init_project(app: AppHandle, base_dir: String, name: String) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(&base_dir).join(&name);
    let game = root.join("game");

    // Create all subdirectories
    for dir in GAME_DIRS {
        fs::create_dir_all(game.join(dir))
            .map_err(|e| format!("Failed to create {}: {}", dir, e))?;
    }

    // Write default config.txt
    let mut config = HashMap::new();
    config.insert("Game_name".to_string(), name.clone());
    config.insert("Game_key".to_string(), format!("{:x}", rand_u64()));
    config.insert(
        "Title_img".to_string(),
        "WebGAL_New_Enter_Image.webp".to_string(),
    );
    config.insert("Title_bgm".to_string(), String::new());

    let config_path = game.join("config.txt");
    fs::write(&config_path, serialize_config(&config))
        .map_err(|e| format!("Failed to write config.txt: {}", e))?;

    // Write default start.txt
    let start_path = game.join("scene").join("start.txt");
    fs::write(&start_path, "; 在这里开始你的故事\n")
        .map_err(|e| format!("Failed to write start.txt: {}", e))?;

    app.asset_protocol_scope()
        .allow_directory(&game, true)
        .map_err(|e| format!("Failed to allow asset directory {}: {}", game.display(), e))?;

    Ok(ProjectInfo {
        path: root.to_string_lossy().to_string(),
        config,
        scenes: vec!["start.txt".to_string()],
    })
}

/// Open an existing WebGAL project by its root directory path.
/// Reads config.txt and lists scene files.
#[tauri::command]
pub fn open_project(app: AppHandle, path: String) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(&path);
    let game = root.join("game");

    if !game.is_dir() {
        return Err(format!(
            "Not a valid WebGAL project: {}/game/ not found",
            root.display()
        ));
    }

    // Read config
    let config_path = game.join("config.txt");
    let config = if config_path.exists() {
        let text = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config.txt: {}", e))?;
        parse_config(&text)
    } else {
        HashMap::new()
    };

    // List scenes
    let scenes = list_txt_files(&game.join("scene"))?;

    app.asset_protocol_scope()
        .allow_directory(&game, true)
        .map_err(|e| format!("Failed to allow asset directory {}: {}", game.display(), e))?;

    Ok(ProjectInfo {
        path: root.to_string_lossy().to_string(),
        config,
        scenes,
    })
}

/// Update config.txt for a project.
#[tauri::command]
pub fn save_config(project_path: String, config: HashMap<String, String>) -> Result<(), String> {
    let config_path = PathBuf::from(&project_path).join("game").join("config.txt");
    fs::write(&config_path, serialize_config(&config))
        .map_err(|e| format!("Failed to write config.txt: {}", e))
}

/// Get the full path for a scene file within a project.
#[tauri::command]
pub fn get_scene_path(project_path: String, scene_name: String) -> Result<String, String> {
    let path = PathBuf::from(&project_path)
        .join("game")
        .join("scene")
        .join(&scene_name);
    Ok(path.to_string_lossy().to_string())
}

/// Create a new scene file in the project.
#[tauri::command]
pub fn create_scene(project_path: String, scene_name: String) -> Result<String, String> {
    let scene_dir = PathBuf::from(&project_path).join("game").join("scene");
    fs::create_dir_all(&scene_dir).map_err(|e| format!("Failed to create scene dir: {}", e))?;

    let name = if scene_name.ends_with(".txt") {
        scene_name
    } else {
        format!("{}.txt", scene_name)
    };

    let path = scene_dir.join(&name);
    if path.exists() {
        return Err(format!("Scene {} already exists", name));
    }

    fs::write(&path, format!("; {}\n", name))
        .map_err(|e| format!("Failed to create scene: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_project_memory(project_path: String) -> Result<Option<ProjectMemory>, String> {
    let path = PathBuf::from(&project_path)
        .join("game")
        .join("ai-memory.json");
    if !path.exists() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read ai-memory.json: {}", e))?;
    let memory = serde_json::from_str::<ProjectMemory>(&text)
        .map_err(|e| format!("Failed to parse ai-memory.json: {}", e))?;
    Ok(Some(memory))
}

#[tauri::command]
pub fn save_project_memory(project_path: String, memory: ProjectMemory) -> Result<(), String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }
    let path = game_dir.join("ai-memory.json");
    let text = serde_json::to_string_pretty(&memory)
        .map_err(|e| format!("Failed to serialize ai-memory.json: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("Failed to write ai-memory.json: {}", e))
}

#[tauri::command]
pub fn read_project_metadata(project_path: String) -> Result<Option<ProjectMetadata>, String> {
    let path = project_metadata_path(&project_path);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

#[tauri::command]
pub fn save_project_metadata(
    project_path: String,
    metadata: ProjectMetadata,
) -> Result<(), String> {
    write_project_metadata(&project_path, &metadata)
}

#[tauri::command]
pub fn create_project_snapshot(
    project_path: String,
    label: Option<String>,
) -> Result<SnapshotInfo, String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }

    let created_at = now_millis().to_string();
    let clean_label = label
        .unwrap_or_else(|| "snapshot".to_string())
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let label = if clean_label.is_empty() {
        "snapshot".to_string()
    } else {
        clean_label
    };
    let id = format!("{created_at}-{label}");
    let snapshot_dir = snapshots_dir(&project_path).join(&id);
    fs::create_dir_all(&snapshot_dir)
        .map_err(|e| format!("Failed to create snapshot directory: {e}"))?;
    copy_dir_recursive(&game_dir, &snapshot_dir.join("game"))?;

    let info = SnapshotInfo {
        id,
        label,
        created_at,
        path: snapshot_dir.to_string_lossy().to_string(),
    };
    let manifest = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    fs::write(snapshot_dir.join("snapshot.json"), manifest)
        .map_err(|e| format!("Failed to write snapshot manifest: {e}"))?;
    Ok(info)
}

#[tauri::command]
pub fn list_project_snapshots(project_path: String) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshots_dir(&project_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("Failed to read snapshots: {e}"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("snapshot.json");
        if !manifest.exists() {
            continue;
        }
        let text = fs::read_to_string(&manifest)
            .map_err(|e| format!("Failed to read {}: {e}", manifest.display()))?;
        if let Ok(info) = serde_json::from_str::<SnapshotInfo>(&text) {
            snapshots.push(info);
        }
    }
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

#[tauri::command]
pub fn restore_project_snapshot(project_path: String, snapshot_id: String) -> Result<(), String> {
    validate_snapshot_id(&snapshot_id)?;
    let root = PathBuf::from(&project_path);
    let game_dir = root.join("game");
    let snapshot_game = snapshots_dir(&project_path).join(&snapshot_id).join("game");
    if !snapshot_game.is_dir() {
        return Err(format!("Snapshot not found: {snapshot_id}"));
    }
    if game_dir.exists() {
        fs::remove_dir_all(&game_dir)
            .map_err(|e| format!("Failed to remove current game directory: {e}"))?;
    }
    copy_dir_recursive(&snapshot_game, &game_dir)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn list_txt_files(dir: &Path) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("txt") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                files.push(name.to_string());
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Simple deterministic-enough u64 for game keys.
fn rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    d.as_nanos() as u64
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Result of exporting a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    pub warnings: Vec<String>,
    pub output_path: String,
    pub issues: Vec<ExportValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportValidationIssue {
    pub level: ExportValidationLevel,
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportValidationLevel {
    Warning,
    Error,
}

/// Export a WebGAL project: copies the game/ directory to the output path.
/// Optionally creates a .zip archive.
#[tauri::command]
pub fn export_project(
    project_path: String,
    output_path: String,
    as_zip: bool,
    metadata: Option<ProjectMetadata>,
) -> Result<ExportResult, String> {
    let game_dir = PathBuf::from(&project_path).join("game");
    if !game_dir.is_dir() {
        return Err(format!("Invalid project: {}/game/ not found", project_path));
    }

    let dest = PathBuf::from(&output_path);
    let mut warnings: Vec<String> = Vec::new();
    let mut issues =
        validate_export_source(&PathBuf::from(&project_path), &game_dir, metadata.as_ref())?;

    // Validate referenced assets before copying
    let asset_warnings = validate_assets(&game_dir)?;
    warnings.extend(asset_warnings);
    warnings.extend(
        issues
            .iter()
            .filter(|issue| issue.level == ExportValidationLevel::Warning)
            .map(|issue| issue.message.clone()),
    );

    if has_export_errors(&issues) {
        return Ok(ExportResult {
            success: false,
            warnings,
            output_path: String::new(),
            issues,
        });
    }

    if let Some(metadata) = metadata.as_ref() {
        write_project_metadata(&project_path, metadata)?;
    }

    let final_output = if as_zip {
        fs::create_dir_all(&dest).map_err(|e| {
            format!(
                "Failed to create export directory {}: {}",
                dest.display(),
                e
            )
        })?;
        let zip_path = dest.join(export_zip_name(&project_path, metadata.as_ref()));
        write_export_zip(&game_dir, metadata.as_ref(), &zip_path)?;
        zip_path
    } else {
        let game_dest = dest.join("game");
        if game_dest.exists() {
            fs::remove_dir_all(&game_dest)
                .map_err(|e| format!("Failed to clear existing export game directory: {e}"))?;
        }
        copy_dir_recursive(&game_dir, &game_dest)?;
        if let Some(metadata) = metadata.as_ref() {
            let metadata_path = dest.join("project-metadata.json");
            let text = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
            fs::write(&metadata_path, text)
                .map_err(|e| format!("Failed to write {}: {e}", metadata_path.display()))?;
        }
        dest
    };

    issues.extend(validate_export_output(
        &final_output,
        as_zip,
        metadata.is_some(),
    )?);
    let success = !has_export_errors(&issues);

    Ok(ExportResult {
        success,
        warnings,
        output_path: final_output.to_string_lossy().to_string(),
        issues,
    })
}

fn validate_export_source(
    project_root: &Path,
    game_dir: &Path,
    metadata: Option<&ProjectMetadata>,
) -> Result<Vec<ExportValidationIssue>, String> {
    let mut issues = Vec::new();

    let config_path = game_dir.join("config.txt");
    if !config_path.is_file() {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "missing_config",
            "导出失败：缺少 game/config.txt",
            Some(&config_path),
        ));
    }

    let scene_dir = game_dir.join("scene");
    let scene_count = list_txt_files(&scene_dir)?.len();
    if scene_count == 0 {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "missing_scene",
            "导出失败：game/scene/ 下至少需要一个 .txt 场景文件",
            Some(&scene_dir),
        ));
    }

    match metadata {
        Some(metadata) => {
            if metadata.version.trim().is_empty() {
                issues.push(export_issue(
                    ExportValidationLevel::Warning,
                    "missing_metadata_version",
                    "项目元信息缺少版本号，导出仍会继续",
                    Some(&project_metadata_path(&project_root.to_string_lossy())),
                ));
            }
            let cover_path = metadata.cover_path.trim();
            if cover_path.is_empty() {
                issues.push(export_issue(
                    ExportValidationLevel::Warning,
                    "missing_cover_path",
                    "项目元信息未设置封面路径，导出仍会继续",
                    Some(&project_metadata_path(&project_root.to_string_lossy())),
                ));
            } else {
                let cover = PathBuf::from(cover_path);
                let resolved = if cover.is_absolute() {
                    cover
                } else {
                    project_root.join(cover)
                };
                if !resolved.exists() {
                    issues.push(export_issue(
                        ExportValidationLevel::Warning,
                        "missing_cover_file",
                        "项目元信息中的封面文件不存在，导出仍会继续",
                        Some(&resolved),
                    ));
                }
            }
        }
        None => issues.push(export_issue(
            ExportValidationLevel::Warning,
            "missing_metadata",
            "未提供项目元信息，导出产物不会包含 project-metadata.json",
            Some(&project_metadata_path(&project_root.to_string_lossy())),
        )),
    }

    Ok(issues)
}

fn validate_export_output(
    output_path: &Path,
    as_zip: bool,
    expect_metadata: bool,
) -> Result<Vec<ExportValidationIssue>, String> {
    if as_zip {
        validate_zip_export_output(output_path, expect_metadata)
    } else {
        Ok(validate_directory_export_output(
            output_path,
            expect_metadata,
        ))
    }
}

fn validate_directory_export_output(
    output_path: &Path,
    expect_metadata: bool,
) -> Vec<ExportValidationIssue> {
    let mut issues = Vec::new();
    let config_path = output_path.join("game").join("config.txt");
    if !config_path.is_file() {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_config",
            "导出产物缺少 game/config.txt",
            Some(&config_path),
        ));
    }

    let scene_dir = output_path.join("game").join("scene");
    let has_scene = list_txt_files(&scene_dir)
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    if !has_scene {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_scene",
            "导出产物缺少 game/scene/*.txt",
            Some(&scene_dir),
        ));
    }

    if expect_metadata {
        let metadata_path = output_path.join("project-metadata.json");
        if !metadata_path.is_file() {
            issues.push(export_issue(
                ExportValidationLevel::Error,
                "export_missing_metadata",
                "导出产物缺少 project-metadata.json",
                Some(&metadata_path),
            ));
        }
    }

    issues
}

fn validate_zip_export_output(
    output_path: &Path,
    expect_metadata: bool,
) -> Result<Vec<ExportValidationIssue>, String> {
    let file = fs::File::open(output_path)
        .map_err(|e| format!("Failed to open export zip {}: {e}", output_path.display()))?;
    let archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "Failed to inspect export zip {}: {e}",
            output_path.display()
        )
    })?;
    let names: Vec<String> = archive.file_names().map(|name| name.to_string()).collect();
    let mut issues = Vec::new();

    if !names.iter().any(|name| name == "game/config.txt") {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_config",
            "导出 zip 缺少 game/config.txt",
            Some(output_path),
        ));
    }

    if !names
        .iter()
        .any(|name| name.starts_with("game/scene/") && name.ends_with(".txt"))
    {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_scene",
            "导出 zip 缺少 game/scene/*.txt",
            Some(output_path),
        ));
    }

    if expect_metadata && !names.iter().any(|name| name == "project-metadata.json") {
        issues.push(export_issue(
            ExportValidationLevel::Error,
            "export_missing_metadata",
            "导出 zip 缺少 project-metadata.json",
            Some(output_path),
        ));
    }

    Ok(issues)
}

fn export_issue(
    level: ExportValidationLevel,
    code: &str,
    message: &str,
    path: Option<&Path>,
) -> ExportValidationIssue {
    ExportValidationIssue {
        level,
        code: code.to_string(),
        message: message.to_string(),
        path: path.map(|p| p.to_string_lossy().to_string()),
    }
}

fn has_export_errors(issues: &[ExportValidationIssue]) -> bool {
    issues
        .iter()
        .any(|issue| issue.level == ExportValidationLevel::Error)
}

/// Scan all scene files and check that referenced assets exist.
fn validate_assets(game_dir: &Path) -> Result<Vec<String>, String> {
    let mut warnings: Vec<String> = Vec::new();
    let scene_dir = game_dir.join("scene");

    if !scene_dir.is_dir() {
        return Ok(warnings);
    }

    let entries =
        fs::read_dir(&scene_dir).map_err(|e| format!("Failed to read scene dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }

        let scene_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        for reference in references::find_asset_references(&content) {
            let asset_path = game_dir.join(reference.category).join(&reference.filename);
            if !asset_path.exists() {
                warnings.push(format!(
                    "[{}] 引用不存在的素材: {} ({}: {})",
                    scene_name, reference.filename, reference.command, reference.filename
                ));
            }
        }
    }

    Ok(warnings)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {}: {}", dst.display(), e))?;

    let entries = fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read entry error: {}", e))?;
        let path = entry.path();
        let dest_path = dst.join(path.file_name().unwrap_or_default());

        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {}",
                    path.display(),
                    dest_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

fn project_metadata_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join("project-metadata.json")
}

fn write_project_metadata(project_path: &str, metadata: &ProjectMetadata) -> Result<(), String> {
    let path = project_metadata_path(project_path);
    let text = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn snapshots_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".webgal-editor")
        .join("snapshots")
}

fn validate_snapshot_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id == "."
        || id == ".."
        || id.contains("..")
    {
        return Err("Invalid snapshot id".to_string());
    }
    Ok(())
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn export_zip_name(project_path: &str, metadata: Option<&ProjectMetadata>) -> String {
    let name = PathBuf::from(project_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("webgal-project")
        .to_string();
    let version = metadata
        .map(|m| m.version.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let clean = |value: &str| {
        value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>()
    };
    format!("{}-{}.zip", clean(&name), clean(version))
}

fn write_export_zip(
    game_dir: &Path,
    metadata: Option<&ProjectMetadata>,
    zip_path: &Path,
) -> Result<(), String> {
    let file = fs::File::create(zip_path)
        .map_err(|e| format!("Failed to create zip {}: {e}", zip_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add_dir_to_zip(&mut zip, game_dir, Path::new("game"), options)?;
    if let Some(metadata) = metadata {
        let text = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
        zip.start_file("project-metadata.json", options)
            .map_err(|e| format!("Failed to add metadata to zip: {e}"))?;
        zip.write_all(&text)
            .map_err(|e| format!("Failed to write metadata to zip: {e}"))?;
    }
    zip.finish()
        .map(|_| ())
        .map_err(|e| format!("Failed to finish zip: {e}"))
}

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    src: &Path,
    zip_base: &Path,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = zip_base.join(entry.file_name());
        let name = name.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{name}/"), options)
                .map_err(|e| format!("Failed to add zip directory {name}: {e}"))?;
            add_dir_to_zip(zip, &path, Path::new(&name), options)?;
        } else {
            zip.start_file(&name, options)
                .map_err(|e| format!("Failed to add zip file {name}: {e}"))?;
            let mut file = fs::File::open(&path)
                .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            zip.write_all(&buffer)
                .map_err(|e| format!("Failed to write zip file {name}: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn export_copies_game_directory() {
        // Setup: create a temp project with game/ structure
        let tmp = std::env::temp_dir().join("webgal_test_export_copy");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::create_dir_all(tmp.join("game").join("bgm")).unwrap();
        fs::create_dir_all(tmp.join("game").join("figure")).unwrap();
        fs::create_dir_all(tmp.join("game").join("sfx")).unwrap();

        // Write some content
        fs::write(tmp.join("game").join("config.txt"), "Game_name:Test;").unwrap();
        fs::write(
            tmp.join("game").join("scene").join("start.txt"),
            "dialogue:Hello;",
        )
        .unwrap();
        fs::write(
            tmp.join("game").join("background").join("bg.webp"),
            "fake-image",
        )
        .unwrap();
        fs::write(tmp.join("game").join("bgm").join("music.mp3"), "fake-audio").unwrap();
        fs::write(tmp.join("game").join("sfx").join("click.wav"), "fake-sfx").unwrap();

        let out = tmp.join("exported");

        // Call export_project
        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));

        // Verify files were copied
        assert!(out.join("game").join("config.txt").exists());
        assert!(out.join("game").join("scene").join("start.txt").exists());
        assert!(out.join("game").join("background").join("bg.webp").exists());
        assert!(out.join("game").join("bgm").join("music.mp3").exists());
        assert!(out.join("game").join("sfx").join("click.wav").exists());

        // Verify content preserved
        assert_eq!(
            fs::read_to_string(out.join("game").join("scene").join("start.txt")).unwrap(),
            "dialogue:Hello;"
        );

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_warns_missing_assets() {
        // Setup: project with scenes referencing both existing and missing assets
        let tmp = std::env::temp_dir().join("webgal_test_export_missing");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::create_dir_all(tmp.join("game").join("bgm")).unwrap();
        fs::create_dir_all(tmp.join("game").join("figure")).unwrap();
        fs::create_dir_all(tmp.join("game").join("sfx")).unwrap();

        // Only bg.webp exists; peaceful.mp3 and missing_figure.webp are referenced but missing
        fs::write(tmp.join("game").join("background").join("bg.webp"), "img").unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:Test;").unwrap();

        // Scene referencing existing and missing assets
        let scene = concat!(
            "changeBg:bg.webp;\n",
            "changeFigure:missing_figure.webp -left;\n",
            "bgm:peaceful.mp3;\n",
            "playEffect:click.wav;\n",
            "playVideo:intro.mp4;\n",
        );
        fs::write(tmp.join("game").join("scene").join("start.txt"), scene).unwrap();

        let out = tmp.join("exported");

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));

        // Should warn about missing_figure.webp and peaceful.mp3 and click.wav
        assert!(
            result.warnings.len() >= 2,
            "expected at least 2 warnings, got {}: {:?}",
            result.warnings.len(),
            result.warnings
        );

        let has_missing_figure = result
            .warnings
            .iter()
            .any(|w| w.contains("missing_figure.webp"));
        let has_missing_bgm = result.warnings.iter().any(|w| w.contains("peaceful.mp3"));
        let has_missing_video = result.warnings.iter().any(|w| w.contains("intro.mp4"));
        assert!(
            has_missing_figure,
            "missing_figure.webp should trigger a warning"
        );
        assert!(has_missing_bgm, "peaceful.mp3 should trigger a warning");
        assert!(has_missing_video, "intro.mp4 should trigger a warning");

        // Should NOT warn about existing asset
        let has_bg = result.warnings.iter().any(|w| w.contains("bg.webp"));
        assert!(!has_bg, "bg.webp exists, should not warn");

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_writes_metadata_and_zip_when_requested() {
        let tmp = std::env::temp_dir().join("webgal_test_export_metadata_zip");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:ZipTest;").unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Hello;").unwrap();
        let out = tmp.join("exported");
        let metadata = ProjectMetadata {
            description: "Export description".to_string(),
            cover_path: "game/background/cover.webp".to_string(),
            version: "1.2.3".to_string(),
            tags: vec!["demo".to_string()],
            ..ProjectMetadata::default()
        };
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::write(
            tmp.join("game").join("background").join("cover.webp"),
            "cover",
        )
        .unwrap();

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            true,
            Some(metadata),
        )
        .unwrap();

        assert!(result.success);
        assert!(!has_export_errors(&result.issues));
        let zip_path = PathBuf::from(result.output_path);
        assert!(zip_path.exists());
        assert!(tmp.join("project-metadata.json").exists());

        let file = fs::File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("game/scene/start.txt").is_ok());
        let mut metadata_file = archive.by_name("project-metadata.json").unwrap();
        let mut metadata_text = String::new();
        metadata_file.read_to_string(&mut metadata_text).unwrap();
        assert!(metadata_text.contains("Export description"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_validation_blocks_missing_required_files() {
        let tmp = std::env::temp_dir().join("webgal_test_export_validation_blocks");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        let out = tmp.join("exported");

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            None,
        )
        .unwrap();

        assert!(!result.success);
        assert!(!out.join("game").exists());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.level == ExportValidationLevel::Error
                && issue.code == "missing_config"));
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.level == ExportValidationLevel::Error
                && issue.code == "missing_scene"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn directory_export_validation_confirms_required_outputs() {
        let tmp = std::env::temp_dir().join("webgal_test_export_directory_validation");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::create_dir_all(tmp.join("game").join("background")).unwrap();
        fs::write(tmp.join("game").join("config.txt"), "Game_name:DirTest;").unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Hello;").unwrap();
        fs::write(
            tmp.join("game").join("background").join("cover.webp"),
            "cover",
        )
        .unwrap();
        let out = tmp.join("exported");
        let metadata = ProjectMetadata {
            cover_path: "game/background/cover.webp".to_string(),
            version: "2.0.0".to_string(),
            ..ProjectMetadata::default()
        };

        let result = export_project(
            tmp.to_string_lossy().to_string(),
            out.to_string_lossy().to_string(),
            false,
            Some(metadata),
        )
        .unwrap();

        assert!(result.success);
        assert!(out.join("game").join("config.txt").is_file());
        assert!(out.join("game").join("scene").join("start.txt").is_file());
        assert!(out.join("project-metadata.json").is_file());
        assert!(!result
            .issues
            .iter()
            .any(|issue| issue.code.starts_with("export_missing")));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn project_metadata_roundtrips() {
        let tmp = std::env::temp_dir().join("webgal_test_metadata_roundtrip");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let metadata = ProjectMetadata {
            synopsis: "Story synopsis".to_string(),
            description: "Description".to_string(),
            cover_path: "game/background/cover.webp".to_string(),
            tags: vec!["demo".to_string(), "branching".to_string()],
            version: "3.1.4".to_string(),
            release_notes: "Notes".to_string(),
            last_export_dir: "/tmp/export".to_string(),
        };

        save_project_metadata(tmp.to_string_lossy().to_string(), metadata.clone()).unwrap();
        let loaded = read_project_metadata(tmp.to_string_lossy().to_string())
            .unwrap()
            .unwrap();

        assert_eq!(loaded.synopsis, metadata.synopsis);
        assert_eq!(loaded.cover_path, metadata.cover_path);
        assert_eq!(loaded.tags, metadata.tags);
        assert_eq!(loaded.version, metadata.version);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_can_restore_previous_game_state() {
        let tmp = std::env::temp_dir().join("webgal_test_snapshot_restore");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("game").join("scene")).unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":Before;").unwrap();

        let snapshot = create_project_snapshot(
            tmp.to_string_lossy().to_string(),
            Some("before".to_string()),
        )
        .unwrap();
        fs::write(tmp.join("game").join("scene").join("start.txt"), ":After;").unwrap();

        let snapshots = list_project_snapshots(tmp.to_string_lossy().to_string()).unwrap();
        assert_eq!(snapshots.len(), 1);
        restore_project_snapshot(tmp.to_string_lossy().to_string(), snapshot.id).unwrap();

        let restored =
            fs::read_to_string(tmp.join("game").join("scene").join("start.txt")).unwrap();
        assert_eq!(restored, ":Before;");
        let _ = fs::remove_dir_all(&tmp);
    }
}
