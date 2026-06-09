import { useState, useCallback, useEffect } from 'react';
import {
  Music, Trash2, Wand2, Upload, Loader2,
  CheckSquare, Square, FolderOpen, ChevronDown, ChevronRight,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { VoiceAssetCard } from '../lib/assets-ipc';
import {
  fillVoiceCard, deleteVoiceCard, importAsset,
} from '../lib/assets-ipc';
import {
  generateBatchTts, listenBatchTtsProgress,
  getAiTtsConfig,
  type BatchTtsItem, type BatchTtsProgress,
} from '../lib/ai-ipc';

interface Props {
  projectPath: string;
  voiceCards: VoiceAssetCard[];
  selectedVoiceCard: VoiceAssetCard | null;
  onSelectVoiceCard: (card: VoiceAssetCard | null) => void;
  onVoiceCardsChanged: () => void;
}

type FilterStatus = 'all' | 'pending' | 'done';
type GroupMode = 'scene' | 'character';

export function VoiceDubbingPanel({
  projectPath,
  voiceCards,
  selectedVoiceCard,
  onSelectVoiceCard,
  onVoiceCardsChanged,
}: Props) {
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [groupMode, setGroupMode] = useState<GroupMode>('scene');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<Map<string, BatchTtsProgress>>(new Map());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [importingId, setImportingId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  // Reload metadata on mount so voice cards are fresh (e.g. after scene save)
  useEffect(() => {
    onVoiceCardsChanged();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter cards
  const filteredCards = voiceCards.filter((card) => {
    if (filterStatus === 'pending') return !card.voiceAsset;
    if (filterStatus === 'done') return !!card.voiceAsset;
    return true;
  });

  // Group cards
  const groups = new Map<string, VoiceAssetCard[]>();
  for (const card of filteredCards) {
    // Extract group key from tags (not available here, derive from ID)
    // voice card IDs are formatted as "voice_{sceneStem}_{index}"
    const parts = card.id.split('_');
    const key = groupMode === 'scene'
      ? (parts.length >= 2 ? parts[1] : '未分类')
      : (card.character || '旁白');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(card);
  }
  // Sort groups by name
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  // Auto-expand all groups
  useEffect(() => {
    setExpandedGroups(new Set(sortedGroups.map(([k]) => k)));
  }, [groupMode, filterStatus, voiceCards.length]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSelect = (cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pendingCards = filteredCards.filter((c) => !c.voiceAsset);
    if (pendingCards.every((c) => selectedIds.has(c.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingCards.map((c) => c.id)));
    }
  };

  // Batch generate
  const handleBatchGenerate = useCallback(async () => {
    const targets = voiceCards.filter((c) => selectedIds.has(c.id) && !c.voiceAsset);
    if (targets.length === 0) return;

    setBatchRunning(true);
    setBatchProgress(new Map());

    const ttsConfig = await getAiTtsConfig().catch(() => null);
    if (!ttsConfig || !ttsConfig.model) {
      alert('请先在 AI 设置中配置 TTS 供应商和模型。');
      setBatchRunning(false);
      return;
    }

    const items: BatchTtsItem[] = targets.map((card) => ({
      voiceCardId: card.id,
      text: card.text,
      voicePrompt: [card.character, card.emotion].filter(Boolean).join(' '),
    }));

    const unlisten = await listenBatchTtsProgress((progress) => {
      setBatchProgress((prev) => {
        const next = new Map(prev);
        next.set(progress.voiceCardId, progress);
        return next;
      });
    });

    try {
      await generateBatchTts(projectPath, items, ttsConfig.model, 'mp3');
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Batch TTS failed:', e);
    } finally {
      unlisten();
      setBatchRunning(false);
      setSelectedIds(new Set());
    }
  }, [projectPath, voiceCards, selectedIds, onVoiceCardsChanged]);

  // Single generate
  const handleSingleGenerate = useCallback(async (card: VoiceAssetCard) => {
    const ttsConfig = await getAiTtsConfig().catch(() => null);
    if (!ttsConfig || !ttsConfig.model) {
      alert('请先在 AI 设置中配置 TTS 供应商和模型。');
      return;
    }
    setGeneratingId(card.id);
    const items: BatchTtsItem[] = [{
      voiceCardId: card.id,
      text: card.text,
      voicePrompt: [card.character, card.emotion].filter(Boolean).join(' '),
    }];
    try {
      setBatchProgress(new Map());
      const unlisten = await listenBatchTtsProgress((p) => {
        setBatchProgress((prev) => { const n = new Map(prev); n.set(p.voiceCardId, p); return n; });
      });
      await generateBatchTts(projectPath, items, ttsConfig.model, 'mp3');
      unlisten();
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Single TTS failed:', e);
      alert(`生成失败: ${e}`);
    } finally {
      setGeneratingId(null);
      setBatchProgress(new Map());
    }
  }, [projectPath, onVoiceCardsChanged]);

  // Import file to fill voice card
  const handleImportFill = useCallback(async (card: VoiceAssetCard) => {
    setImportingId(card.id);
    try {
      const selected = await openDialog({
        title: '选择音频文件',
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'opus'] }],
        multiple: false,
      });
      if (!selected) { setImportingId(null); return; }

      // Import the file
      const assetInfo = await importAsset(selected as string, projectPath, 'vocal');
      // Fill the voice card
      await fillVoiceCard(projectPath, card.id, assetInfo.name);
      onVoiceCardsChanged();
    } catch (e) {
      console.error('Import fill failed:', e);
    } finally {
      setImportingId(null);
    }
  }, [projectPath, onVoiceCardsChanged]);

  // Delete voice card
  const handleDelete = useCallback(async (card: VoiceAssetCard) => {
    if (!window.confirm(`确定删除配音卡 "${card.character}: ${card.text.slice(0, 20)}..." 吗？`)) return;
    try {
      await deleteVoiceCard(projectPath, card.id);
      onVoiceCardsChanged();
      if (selectedVoiceCard?.id === card.id) onSelectVoiceCard(null);
    } catch (e) {
      console.error('Delete voice card failed:', e);
    }
  }, [projectPath, selectedVoiceCard, onSelectVoiceCard, onVoiceCardsChanged]);

  const pendingCount = voiceCards.filter((c) => !c.voiceAsset).length;
  const doneCount = voiceCards.filter((c) => !!c.voiceAsset).length;

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
          配音清单
        </span>
        <div className="flex items-center gap-1 rounded border border-border bg-surface-container-low p-0.5">
          {(['all', 'pending', 'done'] as FilterStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`rounded-sm px-2 py-1 text-[10px] font-semibold transition-colors ${
                filterStatus === s ? 'bg-secondary text-on-secondary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? `全部 (${voiceCards.length})` : s === 'pending' ? `待配音 (${pendingCount})` : `已配音 (${doneCount})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded border border-border bg-surface-container-low p-0.5">
          {(['scene', 'character'] as GroupMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setGroupMode(m)}
              className={`rounded-sm px-2 py-1 text-[10px] font-semibold transition-colors ${
                groupMode === m ? 'bg-secondary text-on-secondary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'scene' ? '按场景' : '按角色'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Batch actions */}
        {filterStatus !== 'done' && (
          <>
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {filteredCards.filter((c) => !c.voiceAsset).every((c) => selectedIds.has(c.id))
                ? <CheckSquare className="h-3.5 w-3.5" />
                : <Square className="h-3.5 w-3.5" />
              }
              全选待配音
            </button>
            <button
              onClick={handleBatchGenerate}
              disabled={batchRunning || selectedIds.size === 0}
              className="flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[11px] font-semibold text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              生成选中 ({selectedIds.size})
            </button>
          </>
        )}
      </div>

      {/* Progress bar for batch */}
      {batchRunning && (
        <div className="shrink-0 border-b border-border bg-primary/5 px-4 py-2">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="text-primary font-semibold">
              生成中... {Array.from(batchProgress.values()).filter((p) => p.status === 'done').length}/{batchProgress.size}
            </span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-secondary/30 overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{
                width: `${batchProgress.size > 0
                  ? (Array.from(batchProgress.values()).filter((p) => p.status === 'done').length / batchProgress.size) * 100
                  : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Card list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {voiceCards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <FolderOpen className="h-12 w-12 opacity-50" />
            <p className="text-sm">暂无配音条目</p>
            <p className="text-xs">在故事编织室保存场景后，对话行会自动生成配音槽位</p>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">没有匹配的配音条目</p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sortedGroups.map(([groupKey, cards]) => {
              const isExpanded = expandedGroups.has(groupKey);
              const groupPending = cards.filter((c) => !c.voiceAsset).length;
              const groupDone = cards.filter((c) => !!c.voiceAsset).length;
              return (
                <div key={groupKey}>
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-surface-container-low transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <span className="text-sm font-semibold">{groupKey}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {cards.length} 条
                      {groupPending > 0 && <span className="ml-1 text-tertiary">({groupPending} 待配音)</span>}
                      {groupDone > 0 && <span className="ml-1 text-primary">({groupDone} 已配音)</span>}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="ml-4 space-y-1">
                      {cards.map((card) => {
                        const isSelected = selectedVoiceCard?.id === card.id;
                        const isChecked = selectedIds.has(card.id);
                        const progress = batchProgress.get(card.id);
                        const isGenerating = generatingId === card.id || progress?.status === 'generating';
                        const hasAudio = !!card.voiceAsset || progress?.status === 'done';

                        return (
                          <div
                            key={card.id}
                            onClick={() => onSelectVoiceCard(card)}
                            className={`group flex items-center gap-3 rounded-sm px-3 py-2 cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-secondary/10 ring-1 ring-secondary/30'
                                : 'hover:bg-surface-container-low'
                            }`}
                          >
                            {/* Checkbox (only for pending) */}
                            {!card.voiceAsset && !isGenerating && (
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleSelect(card.id); }}
                                className="shrink-0"
                              >
                                {isChecked
                                  ? <CheckSquare className="h-4 w-4 text-primary" />
                                  : <Square className="h-4 w-4 text-muted-foreground" />
                                }
                              </button>
                            )}

                            {/* Status icon */}
                            {isGenerating ? (
                              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                            ) : hasAudio ? (
                              <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20">
                                <Music className="h-3 w-3 text-primary" />
                              </div>
                            ) : (
                              <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-tertiary/50">
                                <div className="h-1.5 w-1.5 rounded-full bg-tertiary" />
                              </div>
                            )}

                            {/* Content */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">
                                  {card.character || '旁白'}
                                </span>
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                                  hasAudio ? 'bg-primary/10 text-primary' : 'bg-tertiary/10 text-tertiary'
                                }`}>
                                  {hasAudio ? '已配音' : '待配音'}
                                </span>
                                <span className="rounded bg-secondary/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                  {card.emotion || '默认'}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                                "{card.text}"
                              </p>
                              {progress?.message && progress.status !== 'done' && (
                                <p className="mt-0.5 text-[10px] text-primary/80">{progress.message}</p>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {!card.voiceAsset && !isGenerating && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleSingleGenerate(card); }}
                                  className="rounded p-1.5 hover:bg-primary/10 text-primary transition-colors"
                                  title="AI 生成"
                                >
                                  <Wand2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {!card.voiceAsset && !isGenerating && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleImportFill(card); }}
                                  disabled={importingId === card.id}
                                  className="rounded p-1.5 hover:bg-surface-container-high transition-colors"
                                  title="导入音频"
                                >
                                  {importingId === card.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Upload className="h-3.5 w-3.5" />
                                  }
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(card); }}
                                className="rounded p-1.5 hover:bg-error/10 text-muted-foreground hover:text-error transition-colors"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
