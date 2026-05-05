/**
 * Character data model — mirrors src-tauri/src/characters/types.rs
 */

export interface CharacterSprite {
  emotion: string; // "default", "happy", "sad", "angry", etc.
  file: string;    // filename in game/figure/
}

export interface CharacterRelation {
  targetId: string;
  relationType: string; // "哥哥", "朋友", "敌人", etc.
  description: string;
}

export interface Character {
  id: string;
  name: string;            // primary name used in script dialogue
  aliases: string[];       // nicknames / alternative names
  description: string;     // backstory / role description
  personality: string;     // personality traits
  sprites: CharacterSprite[];
  defaultVoice?: string;   // default voice file path
  voiceTimbre?: string;    // TTS voice type (for future)
  relations: CharacterRelation[];
  colorTheme?: string;     // accent color
  notes: string;           // free-form notes
}

export interface CharacterRef {
  id: string;
  name: string;
}
