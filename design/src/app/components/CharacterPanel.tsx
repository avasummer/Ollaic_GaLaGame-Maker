import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Trash2, ChevronDown, ChevronRight, Users, X,
  Image as ImageIcon, Music, Palette,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Character, CharacterSprite, CharacterRelation, CharacterRef } from '../lib/character-types';
import {
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
} from '../lib/character-ipc';

interface Props {
  projectPath: string;
  onClose: () => void;
}

const inputClass = 'w-full px-2.5 py-1.5 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-xs';
const labelClass = 'block text-[10px] uppercase tracking-wider text-muted-foreground mb-1';

function emptyCharacter(): Character {
  return {
    id: '',
    name: '',
    aliases: [],
    description: '',
    personality: '',
    sprites: [],
    defaultVoice: undefined,
    voiceTimbre: undefined,
    relations: [],
    colorTheme: undefined,
    notes: '',
  };
}

const EMOJI_COLORS = [
  '#D4A574', '#C9946A', '#7C9885', '#60A5FA', '#C084FC',
  '#FACC15', '#F472B6', '#34D399', '#FB923C', '#A78BFA',
];

function pickColor(index: number): string {
  return EMOJI_COLORS[index % EMOJI_COLORS.length];
}

export function CharacterPanel({ projectPath, onClose }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [recentlySavedId, setRecentlySavedId] = useState<string | null>(null);
  const savingRef = useRef(false);    // synchronous guard against double-save
  const savedIds = useRef(new Set<string>()); // track temp IDs already submitted

  // Load on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const list = await listCharacters(projectPath);
        setCharacters(list);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [projectPath]);

  // -- CRUD handlers --

  const handleCreate = useCallback(async () => {
    const newChar = emptyCharacter();
    // Assign a predictable color
    newChar.colorTheme = pickColor(characters.length);
    setIsNew(true);
    setExpandedId(null); // collapse any open card first
    // Use a temporary id
    newChar.id = `tmp_${Date.now()}`;
    setCharacters(prev => [...prev, newChar]);
    setExpandedId(newChar.id);
  }, [characters.length]);

  const handleSave = useCallback(async (ch: Character) => {
    if (!ch.name.trim()) return;
    if (savingRef.current) return;   // block double-click
    // Block re-submit of temp ids already sent to server
    if (ch.id.startsWith('tmp_') && savedIds.current.has(ch.id)) return;

    console.log('[CharacterPanel] Saving character:', ch.id, ch.name);
    savingRef.current = true;
    if (ch.id.startsWith('tmp_')) savedIds.current.add(ch.id);
    setSavingId(ch.id);
    setError(null);
    try {
      if (ch.id.startsWith('tmp_')) {
        console.log('[CharacterPanel] Creating new character on server...');
        const saved = await createCharacter(projectPath, ch);
        console.log('[CharacterPanel] Created, server id:', saved.id);
        setCharacters(prev => prev.map(c => c.id === ch.id ? saved : c));
        if (expandedId === ch.id) setExpandedId(saved.id);
        setIsNew(false);
        setRecentlySavedId(saved.id);
        setTimeout(() => setRecentlySavedId(null), 1500);
      } else {
        console.log('[CharacterPanel] Updating character on server...');
        const saved = await updateCharacter(projectPath, ch);
        console.log('[CharacterPanel] Updated:', saved.id);
        setCharacters(prev => prev.map(c => c.id === ch.id ? saved : c));
        setRecentlySavedId(saved.id);
        setTimeout(() => setRecentlySavedId(null), 1500);
      }
    } catch (e) {
      console.error('[CharacterPanel] Save failed:', e);
      setError(String(e));
      setIsNew(false);
      if (ch.id.startsWith('tmp_')) savedIds.current.delete(ch.id);
    } finally {
      savingRef.current = false;
      setSavingId(null);
    }
  }, [projectPath, expandedId]);

  const handleDelete = useCallback(async (id: string) => {
    setError(null);
    try {
      if (!id.startsWith('tmp_')) {
        await deleteCharacter(projectPath, id);
      }
      setCharacters(prev => prev.filter(c => c.id !== id));
      if (expandedId === id) setExpandedId(null);
      setIsNew(false);
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, expandedId]);

  const handleUpdate = useCallback((id: string, partial: Partial<Character>) => {
    setCharacters(prev =>
      prev.map(c => (c.id === id ? { ...c, ...partial } : c)),
    );
  }, []);

  // -- Sub-field updaters --
  const updateSprite = useCallback((charId: string, idx: number, field: keyof CharacterSprite, value: string) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        const sprites = [...c.sprites];
        sprites[idx] = { ...sprites[idx], [field]: value };
        return { ...c, sprites };
      }),
    );
  }, []);

  const addSprite = useCallback((charId: string) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        return { ...c, sprites: [...c.sprites, { emotion: '', file: '' }] };
      }),
    );
  }, []);

  const removeSprite = useCallback((charId: string, idx: number) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        const sprites = c.sprites.filter((_, i) => i !== idx);
        return { ...c, sprites };
      }),
    );
  }, []);

  const updateRelation = useCallback((charId: string, idx: number, field: keyof CharacterRelation, value: string) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        const relations = [...c.relations];
        relations[idx] = { ...relations[idx], [field]: value };
        return { ...c, relations };
      }),
    );
  }, []);

  const addRelation = useCallback((charId: string) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        return { ...c, relations: [...c.relations, { targetId: '', relationType: '', description: '' }] };
      }),
    );
  }, []);

  const removeRelation = useCallback((charId: string, idx: number) => {
    setCharacters(prev =>
      prev.map(c => {
        if (c.id !== charId) return c;
        const relations = c.relations.filter((_, i) => i !== idx);
        return { ...c, relations };
      }),
    );
  }, []);

  // Other-character options for relation target dropdown
  const otherCharacters = useCallback((excludeId: string): CharacterRef[] =>
    characters
      .filter(c => c.id !== excludeId && c.name.trim())
      .map(c => ({ id: c.id, name: c.name })),
    [characters],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-primary/20">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <h3 className="text-sm uppercase tracking-widest text-muted-foreground"
            style={{ fontFamily: 'var(--font-mono)' }}>
            人物管理
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreate}
            disabled={isNew}
            className="p-1.5 rounded-md hover:bg-primary/20 transition-colors disabled:opacity-30"
            title="添加人物"
          >
            <Plus className="w-4 h-4 text-primary" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-3 mt-2 px-2 py-1.5 rounded bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="ml-auto underline hover:no-underline">关闭</button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground animate-pulse">加载中...</div>
        </div>
      )}

      {/* Character list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {!loading && characters.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
            <Users className="w-10 h-10 opacity-30" />
            <p className="text-xs">尚未添加人物</p>
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              添加人物
            </button>
          </div>
        )}

        {characters.map((ch) => {
          const isExpanded = expandedId === ch.id;
          const isActiveSaving = savingId === ch.id;
          const firstSprite = ch.sprites.length > 0 ? ch.sprites[0].file : null;
          const color = ch.colorTheme || pickColor(characters.indexOf(ch));

          return (
            <div
              key={ch.id}
              className={`rounded-lg border transition-all ${
                isExpanded
                  ? 'border-primary/30 bg-card/80'
                  : 'border-border bg-card/40 hover:border-primary/20'
              }`}
            >
              {/* Collapsed header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : ch.id)}
                className="w-full px-3 py-2.5 flex items-center gap-3 text-left"
              >
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                {firstSprite && (
                  <img
                    src={convertFileSrc(`${projectPath}/game/figure/${firstSprite}`)}
                    className="w-7 h-7 rounded object-cover bg-secondary/50 flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    alt=""
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {ch.name || '(未命名)'}
                  </div>
                  {ch.personality && !isExpanded && (
                    <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {ch.personality}
                    </div>
                  )}
                </div>
                {isExpanded
                  ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                }
              </button>

              {/* Expanded edit form */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t border-border/50 pt-3">
                  {/* Name */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>角色名 *</label>
                    <input
                      type="text"
                      value={ch.name}
                      onChange={(e) => handleUpdate(ch.id, { name: e.target.value })}
                      className={`${inputClass} ${!ch.name.trim() ? 'border-destructive/50 focus:ring-destructive/50' : ''}`}
                      placeholder="例: 春日野 穹"
                    />
                    {!ch.name.trim() && (
                      <p className="text-[10px] text-destructive mt-0.5">请填写角色名后再保存</p>
                    )}
                  </div>

                  {/* Aliases */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>
                      别名（逗号分隔）
                    </label>
                    <input
                      type="text"
                      value={ch.aliases.join(', ')}
                      onChange={(e) => handleUpdate(ch.id, {
                        aliases: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                      })}
                      className={inputClass}
                      placeholder="例: 穹, Sora"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>角色简介</label>
                    <textarea
                      value={ch.description}
                      onChange={(e) => handleUpdate(ch.id, { description: e.target.value })}
                      className={`${inputClass} h-16 resize-none`}
                      placeholder="角色的背景故事与定位..."
                    />
                  </div>

                  {/* Personality */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>性格特征</label>
                    <input
                      type="text"
                      value={ch.personality}
                      onChange={(e) => handleUpdate(ch.id, { personality: e.target.value })}
                      className={inputClass}
                      placeholder="例: 温柔、内向、善良"
                    />
                  </div>

                  {/* Color theme */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>标识颜色</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={ch.colorTheme || pickColor(characters.indexOf(ch))}
                        onChange={(e) => handleUpdate(ch.id, { colorTheme: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-border"
                      />
                      <input
                        type="text"
                        value={ch.colorTheme || ''}
                        onChange={(e) => handleUpdate(ch.id, { colorTheme: e.target.value })}
                        className={`${inputClass} flex-1`}
                        placeholder="hex 颜色值"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                  </div>

                  {/* Sprites */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={labelClass} style={{ fontFamily: 'var(--font-mono)', marginBottom: 0 }}>
                        立绘映射
                      </label>
                      <button
                        onClick={() => addSprite(ch.id)}
                        className="px-2 py-0.5 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />添加
                      </button>
                    </div>
                    {ch.sprites.length === 0 && (
                      <p className="text-[10px] text-muted-foreground">暂无立绘映射，点击"添加"创建</p>
                    )}
                    <div className="space-y-2">
                      {ch.sprites.map((sprite, idx) => (
                        <div key={idx} className="flex items-center gap-2 p-2 bg-secondary/20 rounded-md">
                          <div className="flex-1 space-y-1">
                            <input
                              type="text"
                              value={sprite.emotion}
                              onChange={(e) => updateSprite(ch.id, idx, 'emotion', e.target.value)}
                              className={`${inputClass} text-[10px]`}
                              placeholder="表情 (默认/开心/悲伤...)"
                            />
                            <div className="flex items-center gap-1">
                              <ImageIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              <input
                                type="text"
                                value={sprite.file}
                                onChange={(e) => updateSprite(ch.id, idx, 'file', e.target.value)}
                                className={`${inputClass} text-[10px]`}
                                placeholder="figure 文件名"
                                style={{ fontFamily: 'var(--font-mono)' }}
                              />
                            </div>
                          </div>
                          <button
                            onClick={() => removeSprite(ch.id, idx)}
                            className="p-1 hover:bg-destructive/10 rounded transition-colors flex-shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Voice */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>语音设置</label>
                    <div className="space-y-2">
                      <div className="flex items-center gap-1">
                        <Music className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <input
                          type="text"
                          value={ch.defaultVoice || ''}
                          onChange={(e) => handleUpdate(ch.id, {
                            defaultVoice: e.target.value || undefined,
                          })}
                          className={`${inputClass} text-[10px]`}
                          placeholder="默认语音文件 (vocal/)"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        />
                      </div>
                      <input
                        type="text"
                        value={ch.voiceTimbre || ''}
                        onChange={(e) => handleUpdate(ch.id, {
                          voiceTimbre: e.target.value || undefined,
                        })}
                        className={`${inputClass} text-[10px]`}
                        placeholder="TTS 音色 (未来扩展)"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                  </div>

                  {/* Relations */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={labelClass} style={{ fontFamily: 'var(--font-mono)', marginBottom: 0 }}>
                        人物关系
                      </label>
                      <button
                        onClick={() => addRelation(ch.id)}
                        className="px-2 py-0.5 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />添加
                      </button>
                    </div>
                    {ch.relations.length === 0 && (
                      <p className="text-[10px] text-muted-foreground">暂无关系</p>
                    )}
                    <div className="space-y-2">
                      {ch.relations.map((rel, idx) => {
                        const targets = otherCharacters(ch.id);
                        return (
                          <div key={idx} className="p-2 bg-secondary/20 rounded-md space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
                                关系 {idx + 1}
                              </span>
                              <button
                                onClick={() => removeRelation(ch.id, idx)}
                                className="p-0.5 hover:bg-destructive/10 rounded"
                              >
                                <Trash2 className="w-3 h-3 text-muted-foreground hover:text-destructive" />
                              </button>
                            </div>
                            <select
                              value={rel.targetId}
                              onChange={(e) => updateRelation(ch.id, idx, 'targetId', e.target.value)}
                              className={`${inputClass} text-[10px]`}
                            >
                              <option value="">选择目标角色...</option>
                              {targets.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={rel.relationType}
                              onChange={(e) => updateRelation(ch.id, idx, 'relationType', e.target.value)}
                              className={`${inputClass} text-[10px]`}
                              placeholder="关系类型 (哥哥/朋友/敌人...)"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <label className={labelClass} style={{ fontFamily: 'var(--font-mono)' }}>备注</label>
                    <textarea
                      value={ch.notes}
                      onChange={(e) => handleUpdate(ch.id, { notes: e.target.value })}
                      className={`${inputClass} h-12 resize-none`}
                      placeholder="额外备注..."
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => handleSave(ch)}
                      disabled={isActiveSaving || !ch.name.trim()}
                      className={`flex-1 px-3 py-2 rounded-md transition-all text-xs font-medium disabled:opacity-50 ${
                        recentlySavedId === ch.id
                          ? 'bg-emerald-600 text-white'
                          : 'bg-primary text-primary-foreground hover:opacity-90'
                      }`}
                    >
                      {isActiveSaving ? '保存中...' : recentlySavedId === ch.id ? '已保存' : '保存'}
                    </button>
                    <button
                      onClick={() => handleDelete(ch.id)}
                      disabled={isActiveSaving}
                      className="px-3 py-2 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors text-xs disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {characters.length} 个角色
        </span>
        <span className="text-[10px]">
          {characters.reduce((sum, c) => sum + c.sprites.length, 0)} 个立绘映射
        </span>
      </div>
    </div>
  );
}
