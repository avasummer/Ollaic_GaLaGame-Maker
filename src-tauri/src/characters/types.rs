use serde::{Deserialize, Serialize};

/// A single sprite/expression variation for a character.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSprite {
    /// Emotion label, e.g. "default", "happy", "sad", "angry", "surprised".
    pub emotion: String,
    /// Filename relative to game/figure/, e.g. "girl_happy.webp".
    pub file: String,
}

/// A directional relation to another character.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelation {
    /// Target character id.
    pub target_id: String,
    /// Relation type in Chinese, e.g. "哥哥", "朋友", "敌人".
    pub relation_type: String,
    /// Optional detail.
    #[serde(default)]
    pub description: String,
}

/// A character in the visual novel project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    /// Primary name used in script dialogue lines.
    pub name: String,
    /// Alternative names / nicknames.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Backstory / role description.
    #[serde(default)]
    pub description: String,
    /// Personality traits.
    #[serde(default)]
    pub personality: String,
    /// Emotion → figure file mappings.
    #[serde(default)]
    pub sprites: Vec<CharacterSprite>,
    /// Default voice file path (relative to game/vocal/).
    #[serde(default)]
    pub default_voice: Option<String>,
    /// TTS voice type identifier (for future use).
    #[serde(default)]
    pub voice_timbre: Option<String>,
    /// Relations to other characters.
    #[serde(default)]
    pub relations: Vec<CharacterRelation>,
    /// Display accent color (CSS-compatible string).
    #[serde(default)]
    pub color_theme: Option<String>,
    /// Free-form notes.
    #[serde(default)]
    pub notes: String,
}

/// Lightweight reference for dropdowns / lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRef {
    pub id: String,
    pub name: String,
}

/// Top-level characters.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharactersDocument {
    pub version: u32,
    #[serde(default)]
    pub characters: Vec<Character>,
}

impl Default for CharactersDocument {
    fn default() -> Self {
        Self {
            version: 1,
            characters: Vec::new(),
        }
    }
}
