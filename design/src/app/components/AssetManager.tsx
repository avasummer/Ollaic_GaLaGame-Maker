import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft,
  Upload,
  Search,
  Image,
  Music,
  Users,
  FolderOpen,
  Grid3x3,
  List,
  Play,
  Pause,
  Trash2,
  Edit3,
  Plus,
  Sparkles,
  Tag,
  Filter,
  Loader2,
  AlertTriangle,
  Copy,
  X,
  Award,
  CheckCircle,
  Shuffle,
  Eraser,
  HardDrive,
  Eye,
  Minimize2,
} from 'lucide-react';
import {
  listAssets,
  listAllAssets,
  importAsset,
  deleteAsset,
  findAssetUsages,
  renameAsset,
  type AssetInfo,
  type AssetUsage,
  type SceneAssetCard,
  type VoiceAssetCard,
} from '../lib/assets-ipc';
import {
  assetMetadataEntry,
  emptyAssetMetadata,
  flushAssetMetadataSaves,
  loadAssetMetadata,
  referenceCategoryForAsset,
  referenceFilePath,
  saveAssetMetadata,
  setAssetAlias,
  setAssetDescription,
  setAssetReferences,
  type AssetMetadata,
} from '../lib/asset-metadata';
import {
  getAiImageConfig,
  getAiTtsConfig,
  type AiProviderConfig,
} from '../lib/ai-ipc';
import { getScenePath, loadScene, openProject, saveScene } from '../lib/webgal-ipc';
import type { WebGalNode } from '../lib/webgal-types';
import { listCharacters } from '../lib/character-ipc';
import { CharacterPanel } from './CharacterPanel';
import { StoryOsSideNav, StoryOsTopBar } from './StoryOsChrome';

type TabId = 'scene' | 'cg' | 'music' | 'character';
type MusicCategory = 'bgm' | 'sfx' | 'vocal';
type SceneLibraryItem =
  | { kind: 'sceneCard'; card: SceneAssetCard; asset?: AssetInfo }
  | { kind: 'asset'; asset: AssetInfo };
type VoiceLibraryItem =
  | { kind: 'voiceCard'; card: VoiceAssetCard; asset?: AssetInfo }
  | { kind: 'asset'; asset: AssetInfo };

const musicTabs: { id: MusicCategory; label: string }[] = [
  { id: 'bgm', label: 'BGM 背景音乐' },
  { id: 'sfx', label: 'SFX 音效' },
  { id: 'vocal', label: '语音 Vocal' },
];

const musicCategoryLabels: Record<MusicCategory, string> = {
  bgm: 'BGM',
  sfx: '音效',
  vocal: '语音',
};

const sceneTagGroups = [
  { title: '时段', tags: ['白天', '黄昏', '夜晚', '雨天'] },
  { title: '场景类型', tags: ['室内', '室外', '幻想', '战斗'] },
];

const voiceEmotionOptions = [
  '默认',
  '平静',
  '温柔',
  '开心',
  '害羞',
  '惊讶',
  '疑惑',
  '紧张',
  '害怕',
  '生气',
  '悲伤',
  '哭腔',
  '低声',
  '认真',
  '冷淡',
  '虚弱',
  '激动',
  '撒娇',
  '嘲讽',
];

function tabToCategories(tab: TabId): string[] {
  switch (tab) {
    case 'scene': return ['background'];
    case 'cg': return ['background'];
    case 'music': return ['bgm', 'sfx', 'vocal'];
    case 'character': return ['figure'];
  }
}

function isImageExt(ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(normalized);
}

function isAudioExt(ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return ['mp3', 'ogg', 'wav', 'flac', 'aac'].includes(normalized);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCategory(category: string): string {
  const labels: Record<string, string> = {
    background: '背景',
    figure: '立绘',
    bgm: '背景音乐',
    sfx: '音效',
    vocal: '语音',
  };
  return labels[category] || category;
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function getSafeAudioDuration(audio: HTMLAudioElement): number {
  return Number.isFinite(audio.duration) ? audio.duration : 0;
}

function countUsages(usages: AssetUsage[], _filename: string): number {
  // AssetUsage is per-call (one filename), so any returned entry is one usage reference.
  return usages.length;
}

function getImportConfig(tab: TabId, musicCategory: MusicCategory) {
  if (tab === 'scene') {
    return {
      title: '上传背景素材',
      buttonLabel: '上传背景',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    };
  }
  if (tab === 'cg') {
    return {
      title: '上传 CG 剧情画',
      buttonLabel: '上传 CG',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    };
  }
  if (tab === 'music') {
    return {
      title: `上传${musicCategoryLabels[musicCategory]}`,
      buttonLabel: `上传${musicCategoryLabels[musicCategory]}`,
      filters: [{ name: '音频文件', extensions: ['mp3', 'ogg', 'wav', 'flac', 'aac'] }],
    };
  }
  return {
    title: '上传立绘素材',
    buttonLabel: '上传立绘素材',
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
  };
}

function getAudioDurationLabel(
  assetPath: string,
  audioDurations: Record<string, number>,
  audioMetadataErrors: Record<string, boolean>,
): string {
  if (audioMetadataErrors[assetPath]) return '无法读取时长';
  return formatDuration(audioDurations[assetPath]);
}

const tabConfig: { id: TabId; label: string; icon: typeof Image }[] = [
  { id: 'scene', label: '场景', icon: Image },
  { id: 'cg', label: 'CG', icon: Award },
  { id: 'music', label: '音乐', icon: Music },
  { id: 'character', label: '人物立绘', icon: Users },
];

export function AssetManager() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState<TabId>(
    searchParams.get('tab') === 'character' ? 'character' : 'scene',
  );
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<AssetInfo | null>(null);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [musicCategory, setMusicCategory] = useState<MusicCategory>('bgm');
  const [characterCount, setCharacterCount] = useState(0);
  const [characterGenerationRequestToken, setCharacterGenerationRequestToken] = useState(0);
  const [figureLibraryRefreshToken, setFigureLibraryRefreshToken] = useState(0);
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({});
  const [audioMetadataErrors, setAudioMetadataErrors] = useState<Record<string, boolean>>({});
  const [audioProgress, setAudioProgress] = useState<Record<string, number>>({});
  const [assetUsages, setAssetUsages] = useState<AssetUsage[]>([]);
  const [metadata, setMetadata] = useState<AssetMetadata>(() => emptyAssetMetadata());
  const metadataRef = useRef<AssetMetadata>(emptyAssetMetadata());
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [aiGenerateOpen, setAiGenerateOpen] = useState(false);
  const [editingSceneCard, setEditingSceneCard] = useState<SceneAssetCard | null>(null);
  const [selectedSceneCard, setSelectedSceneCard] = useState<SceneAssetCard | null>(null);
  const [voiceCards, setVoiceCards] = useState<VoiceAssetCard[]>([]);
  const [selectedVoiceCard, setSelectedVoiceCard] = useState<VoiceAssetCard | null>(null);
  const [aiAssetPrompt, setAiAssetPrompt] = useState('');

  // Real data state
  const [projectPath, setProjectPath] = useState<string>('');
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [allAssets, setAllAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const applyMetadata = useCallback((metadata: AssetMetadata) => {
    metadataRef.current = metadata;
    setMetadata(metadata);
  }, []);

  // Load project path
  useEffect(() => {
    const path = localStorage.getItem(`project-path-${projectId}`);
    if (path) {
      setProjectPath(path);
    } else {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'character') {
      setActiveTab('character');
    } else if (!tabParam) {
      setActiveTab('scene');
    }
  }, [searchParams]);

  // Load assets on mount and tab change
  const loadAssetsForTab = useCallback(async (tab: TabId, path: string, musicSubtab: MusicCategory) => {
    setLoading(true);
    setError(null);
    try {
      const cats = tab === 'music' ? [musicSubtab] : tabToCategories(tab);
      const results = await Promise.all(cats.map(c => listAssets(path, c)));
      const all = results.flat();
      setAssets(all);
    } catch (e) {
      setError(String(e));
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load all assets for counts and "all folders" view
  const loadAllAssets = useCallback(async (path: string) => {
    try {
      const all = await listAllAssets(path);
      setAllAssets(all);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    if (!projectPath) return;
    loadAssetsForTab(activeTab, projectPath, musicCategory);
    loadAllAssets(projectPath);
  }, [projectPath, activeTab, musicCategory, loadAssetsForTab, loadAllAssets]);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    listCharacters(projectPath)
      .then((list) => {
        if (!cancelled) setCharacterCount(list.length);
      })
      .catch(() => {
        if (!cancelled) setCharacterCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, figureLibraryRefreshToken]);

  // Load usage map for all assets to power "Used in X scenes" badges
  useEffect(() => {
    if (!projectPath) {
      setAssetUsages([]);
      return;
    }
    let cancelled = false;
    const loadAllUsages = async () => {
      try {
        const results = await Promise.all(
          allAssets.map((a) => findAssetUsages(projectPath, a.name, a.category).catch(() => [])),
        );
        if (cancelled) return;
        const flat = results.flat();
        setAssetUsages(flat);
      } catch {
        if (!cancelled) setAssetUsages([]);
      }
    };
    loadAllUsages();
    return () => { cancelled = true; };
  }, [projectPath, allAssets]);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    loadAssetMetadata(projectPath, projectId)
      .then((next) => {
        if (!cancelled) applyMetadata(next);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => { cancelled = true; };
  }, [applyMetadata, projectId, projectPath]);

  useEffect(() => {
    if (!projectPath || activeTab !== 'music' || musicCategory !== 'vocal') {
      setVoiceCards([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await openProject(projectPath);
        const cardMap = new Map<string, VoiceAssetCard>();
        for (const sceneName of info.scenes) {
          const scenePath = await getScenePath(projectPath, sceneName);
          const nodes = await loadScene(scenePath);
          let sceneChanged = false;
          nodes.forEach((node: WebGalNode, index: number) => {
            if (node.type !== 'dialogue') return;
            const text = node.content.trim();
            if (!text) return;
            const character = (node.character ?? '').trim();
            const storedCards = metadataRef.current.voiceCards ?? {};
            const legacyId = hashText(`${character}\n${text}`);
            const legacyStored = storedCards[legacyId];
            const emotion = legacyStored?.emotion || '默认';
            const id = voiceCardId(character, text, emotion);
            if ((metadataRef.current.deletedVoiceCards ?? []).includes(id)) return;
            const stored = storedCards[id] ?? legacyStored;
            const targetStem = stored?.targetStem || voiceTargetStem(character, text);
            const targetVoice = stored?.voiceAsset ?? node.voice ?? `${targetStem}.wav`;
            if (!node.voice) {
              node.voice = targetVoice;
              sceneChanged = true;
            }
            const existing = cardMap.get(id);
            const usage: AssetUsage = {
              sceneFile: sceneName,
              lineNumber: index + 1,
              lineContent: `${character ? `${character}:` : ':'}${text};`,
              command: 'voice',
            };
            if (existing) {
              existing.usages = [...(existing.usages ?? []), usage];
              if (!existing.voiceAsset) existing.voiceAsset = targetVoice;
              return;
            }
            cardMap.set(id, {
              id,
              character,
              text,
              emotion: stored?.emotion || emotion,
              voiceAsset: targetVoice,
              targetStem,
              prompt: stored?.prompt || '',
              usages: [usage],
            });
          });
          if (sceneChanged) {
            await saveScene(scenePath, nodes);
          }
        }
        if (!cancelled) setVoiceCards(Array.from(cardMap.values()));
      } catch (e) {
        if (!cancelled) {
          setVoiceCards([]);
          setError(String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, musicCategory, projectPath, metadata]);

  const aliasForAsset = (asset: Pick<AssetInfo, 'category' | 'name'>): string =>
    assetMetadataEntry(metadata.aliases, asset.category, asset.name) ?? '';
  const descriptionForAsset = (asset: Pick<AssetInfo, 'category' | 'name'>): string =>
    assetMetadataEntry(metadata.descriptions, asset.category, asset.name) ?? '';
  const referencesForAsset = (asset: Pick<AssetInfo, 'category' | 'name'>): string[] =>
    assetMetadataEntry(metadata.references, asset.category, asset.name) ?? [];

  const filteredAssets = assets.filter((a) => {
    const q = searchQuery.toLowerCase();
    return a.name.toLowerCase().includes(q) || aliasForAsset(a).toLowerCase().includes(q);
  });

  const sceneLibraryItems: SceneLibraryItem[] = (() => {
    const cards = Object.values(metadata.sceneCards ?? {});
    const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
    const usedAssets = new Set<string>();
    const cardItems = cards.map((card) => {
      const asset = card.imageAsset ? assetByName.get(card.imageAsset) : undefined;
      if (asset) usedAssets.add(asset.name);
      return { kind: 'sceneCard' as const, card, asset };
    });
    const looseAssets = assets
      .filter((asset) => !usedAssets.has(asset.name))
      .map((asset) => ({ kind: 'asset' as const, asset }));
    return [...cardItems, ...looseAssets].filter((item) => {
      const q = searchQuery.toLowerCase();
      if (!q) return true;
      if (item.kind === 'sceneCard') {
        return item.card.title.toLowerCase().includes(q)
          || item.card.prompt.toLowerCase().includes(q)
          || (item.card.sceneFile ?? '').toLowerCase().includes(q)
          || (item.card.imageAsset ?? '').toLowerCase().includes(q);
      }
      return item.asset.name.toLowerCase().includes(q) || aliasForAsset(item.asset).toLowerCase().includes(q);
    });
  })();

  const voiceLibraryItems: VoiceLibraryItem[] = (() => {
    const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
    const usedAssets = new Set<string>();
    const cardItems = voiceCards.map((card) => {
      const asset = card.voiceAsset ? assetByName.get(card.voiceAsset) : undefined;
      if (asset) usedAssets.add(asset.name);
      return { kind: 'voiceCard' as const, card, asset };
    });
    const looseAssets = assets
      .filter((asset) => !usedAssets.has(asset.name))
      .map((asset) => ({ kind: 'asset' as const, asset }));
    const q = searchQuery.toLowerCase();
    return [...cardItems, ...looseAssets].filter((item) => {
      if (!q) return true;
      if (item.kind === 'voiceCard') {
        return item.card.character.toLowerCase().includes(q)
          || item.card.text.toLowerCase().includes(q)
          || (item.card.voiceAsset ?? '').toLowerCase().includes(q);
      }
      return item.asset.name.toLowerCase().includes(q) || aliasForAsset(item.asset).toLowerCase().includes(q);
    });
  })();

  // Tab counts from all assets
  const tabCounts = {
    scene: allAssets.filter(a => a.category === 'background').length,
    cg: allAssets.filter(a => a.category === 'background').length,
    music: allAssets.filter(a => a.category === 'bgm' || a.category === 'sfx' || a.category === 'vocal').length,
    character: characterCount,
  };

  const importConfig = getImportConfig(activeTab, musicCategory);
  const aiActionLabel = activeTab === 'scene'
    ? 'AI 生成背景'
    : activeTab === 'cg'
      ? 'AI 生成 CG 剧情画'
      : activeTab === 'music'
        ? `AI 生成${musicCategoryLabels[musicCategory]}`
        : '批量生成当前角色立绘';

  const totalStorageBytes = allAssets.reduce((sum, a) => sum + (a.size ?? 0), 0);
  const storageQuotaBytes = 2 * 1024 * 1024 * 1024;
  const storagePercent = Math.min(100, Math.round((totalStorageBytes / storageQuotaBytes) * 100));

  // --- Actions ---
  const handleImport = useCallback(async () => {
    if (!projectPath || !importConfig) return;
    const path = await openDialog({
      title: importConfig.title,
      filters: importConfig.filters,
    });
    if (!path) return;

    setImporting(true);
    setError(null);
    try {
      const cats = activeTab === 'music' ? [musicCategory] : tabToCategories(activeTab);
      const info = await importAsset(Array.isArray(path) ? path[0] : path, projectPath, cats[0]);
      setAssets(prev => [info, ...prev]);
      if (activeTab === 'character') {
        setFigureLibraryRefreshToken((value) => value + 1);
      }
      // Refresh all assets for updated counts
      loadAllAssets(projectPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }, [projectPath, activeTab, importConfig, musicCategory, loadAllAssets]);

  const handleDelete = useCallback(async (asset?: AssetInfo) => {
    const target = asset ?? selectedAsset;
    if (!target || !projectPath) return;

    try {
      const usages = await findAssetUsages(projectPath, target.name, target.category);
      const usageWarning = usages.length > 0
        ? `\n该素材仍被 ${usages.length} 处剧本引用，删除后这些引用将失效。`
        : '';
      if (!confirm(`确定删除 "${target.name}"？（不可恢复）${usageWarning}`)) return;
      await flushAssetMetadataSaves(projectPath);
      await deleteAsset(projectPath, target.category, target.name);
      setAssets(prev => prev.filter(a => a.path !== target.path));
      setAllAssets(prev => prev.filter(a => a.path !== target.path));
      applyMetadata(await loadAssetMetadata(projectPath));
      if (selectedAsset?.path === target.path) setSelectedAsset(null);
    } catch (e) {
      setError(String(e));
    }
  }, [applyMetadata, selectedAsset, projectPath]);

  const handleRename = useCallback(async () => {
    if (!selectedAsset || !projectPath) return;
    const ext = selectedAsset.extension;
    const stem = selectedAsset.name.slice(0, -(ext.length + 1));
    const newName = prompt('输入新名称:', stem);
    if (!newName || newName === stem) return;

    const fullNewName = `${newName}.${ext}`;
    try {
      await flushAssetMetadataSaves(projectPath);
      const info = await renameAsset(projectPath, selectedAsset.category, selectedAsset.name, fullNewName);
      setAssets(prev => prev.map(a => a.path === selectedAsset.path ? info : a));
      setAllAssets(prev => prev.map(a => a.path === selectedAsset.path ? info : a));
      applyMetadata(await loadAssetMetadata(projectPath));
      setSelectedAsset(info);
    } catch (e) {
      setError(String(e));
    }
  }, [applyMetadata, selectedAsset, projectPath]);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePlayToggle = useCallback(async (assetPath: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingAudio === assetPath) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
      setPlayingAudio(null);
      return;
    }

    setError(null);
    setAudioProgress((prev) => ({ ...prev, [assetPath]: 0 }));
    audio.pause();
    audio.src = convertFileSrc(assetPath);
    audio.load();

    try {
      await audio.play();
      setPlayingAudio(assetPath);
    } catch (e) {
      setPlayingAudio(null);
      setError(`无法播放音频：${String(e)}`);
    }
  }, [playingAudio]);

  const persistMetadata = useCallback((next: AssetMetadata) => {
    applyMetadata(next);
    if (!projectPath) return;
    void saveAssetMetadata(projectPath, next).catch((e) => setError(String(e)));
  }, [applyMetadata, projectPath]);

  useEffect(() => {
    if (!projectPath || activeTab !== 'scene') return;
    const sceneFile = searchParams.get('scene');
    if (!sceneFile) return;
    const id = sceneCardId(sceneFile);
    if (metadataRef.current.sceneCards?.[id]) return;
    if ((metadataRef.current.deletedSceneCards ?? []).includes(id)) return;
    const currentMetadata = metadataRef.current;
    const nextCard: SceneAssetCard = {
      id,
      title: sceneTitleFromFile(sceneFile),
      sceneFile,
      imageAsset: null,
      targetStem: defaultSceneTargetStem(Object.keys(metadataRef.current.sceneCards ?? {}).length + 1),
      prompt: '',
      style: '',
      negativePrompt: '',
    };
    persistMetadata({
      ...currentMetadata,
      sceneCards: {
        ...(currentMetadata.sceneCards ?? {}),
        [id]: nextCard,
      },
    });
  }, [activeTab, persistMetadata, projectPath, searchParams]);

  const handleReferenceUpload = useCallback(async () => {
    if (!selectedAsset || !projectPath) return;
    const isAudioReference = selectedAsset.category !== 'background';
    const referenceCategory = referenceCategoryForAsset(selectedAsset.category, selectedAsset.name);
    if (!referenceCategory) return;
    const path = await openDialog({
      title: isAudioReference ? '上传参考音频' : '上传参考图',
      filters: [{
        name: isAudioReference ? '音频文件' : '图片文件',
        extensions: isAudioReference ? ['mp3', 'ogg', 'wav', 'flac', 'aac'] : ['png', 'jpg', 'jpeg', 'webp'],
      }],
    });
    if (!path) return;

    setReferenceUploading(true);
    setError(null);
    try {
      const info = await importAsset(Array.isArray(path) ? path[0] : path, projectPath, referenceCategory);
      const currentMetadata = metadataRef.current;
      const current = assetMetadataEntry(
        currentMetadata.references,
        selectedAsset.category,
        selectedAsset.name,
      ) ?? [];
      persistMetadata(setAssetReferences(
        currentMetadata,
        selectedAsset.category,
        selectedAsset.name,
        [...current, info.name],
      ));
    } catch (e) {
      setError(String(e));
    } finally {
      setReferenceUploading(false);
    }
  }, [persistMetadata, projectPath, selectedAsset]);

  const handleReferenceRemove = useCallback(async (filename: string) => {
    if (!selectedAsset || !projectPath) return;
    const referenceCategory = referenceCategoryForAsset(selectedAsset.category, selectedAsset.name);
    if (!referenceCategory) return;
    try {
      await deleteAsset(projectPath, referenceCategory, filename);
    } catch {
      // Keep the local reference list clean even if the backing file was already gone.
    }
    const currentMetadata = metadataRef.current;
    const current = assetMetadataEntry(
      currentMetadata.references,
      selectedAsset.category,
      selectedAsset.name,
    ) ?? [];
    persistMetadata(setAssetReferences(
      currentMetadata,
      selectedAsset.category,
      selectedAsset.name,
      current.filter((name) => name !== filename),
    ));
  }, [persistMetadata, projectPath, selectedAsset]);

  // Keep the shared audio element in sync when playback is cleared externally.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!playingAudio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
    }
  }, [playingAudio]);

  useEffect(() => {
    if (!selectedAsset || !projectPath) {
      setAssetUsages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const usages = await findAssetUsages(projectPath, selectedAsset.name, selectedAsset.category);
        if (!cancelled) setAssetUsages(usages);
      } catch {
        if (!cancelled) setAssetUsages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, selectedAsset]);

  const openUsage = useCallback((usage: AssetUsage) => {
    navigate(`/editor/${projectId}?scene=${encodeURIComponent(usage.sceneFile)}&line=${usage.lineNumber}`);
  }, [navigate, projectId]);

  const runAssetTool = useCallback((tool: 'compress' | 'validate' | 'convert' | 'purge') => {
    const labels: Record<typeof tool, string> = {
      compress: '资源压缩',
      validate: '素材校验',
      convert: '转换为 WEBP',
      purge: '清理未使用素材',
    };
    alert(`${labels[tool]} 功能即将推出`);
  }, []);

  // Thumbnail URL
  const getThumbnail = (asset: AssetInfo): string | null => {
    if (isImageExt(asset.extension)) {
      return convertFileSrc(asset.path);
    }
    return null;
  };

  const handleAliasChange = (asset: AssetInfo, alias: string) => {
    persistMetadata(setAssetAlias(metadata, asset.category, asset.name, alias));
  };

  const handleDescriptionChange = (asset: AssetInfo, description: string) => {
    persistMetadata(setAssetDescription(metadata, asset.category, asset.name, description));
  };

  const handleGenerateFromAsset = (asset: AssetInfo) => {
    if (asset.category === 'background') {
      const stem = asset.name.replace(/\.[^.]+$/, '');
      setEditingSceneCard({
        id: sceneCardId(stem),
        title: aliasForAsset(asset) || stem,
        sceneFile: null,
        imageAsset: asset.name,
        targetStem: stem,
        prompt: descriptionForAsset(asset),
        style: '',
        negativePrompt: '',
      });
      setAiGenerateOpen(true);
      return;
    }
    setEditingSceneCard(null);
    setAiAssetPrompt(descriptionForAsset(asset));
    setAiGenerateOpen(true);
  };

  const handleEditSceneCard = useCallback((card: SceneAssetCard) => {
    setSelectedSceneCard(card);
    setEditingSceneCard(card);
    setSelectedAsset(null);
    setSelectedVoiceCard(null);
  }, []);

  const handleSaveSceneCard = useCallback((card: SceneAssetCard) => {
    const currentMetadata = metadataRef.current;
    persistMetadata({
      ...currentMetadata,
      deletedSceneCards: (currentMetadata.deletedSceneCards ?? []).filter((id) => id !== card.id),
      sceneCards: {
        ...(currentMetadata.sceneCards ?? {}),
        [card.id]: card,
      },
    });
    setSelectedSceneCard(card);
  }, [persistMetadata]);

  const handleSaveVoiceCard = useCallback((card: VoiceAssetCard) => {
    const currentMetadata = metadataRef.current;
    const normalizedCard = {
      ...card,
      id: voiceCardId(card.character, card.text, card.emotion || '默认'),
      emotion: card.emotion || '默认',
    };
    const nextVoiceCards = { ...(currentMetadata.voiceCards ?? {}) };
    if (normalizedCard.id !== card.id) delete nextVoiceCards[card.id];
    nextVoiceCards[normalizedCard.id] = {
      id: normalizedCard.id,
      character: normalizedCard.character,
      text: normalizedCard.text,
      emotion: normalizedCard.emotion,
      voiceAsset: normalizedCard.voiceAsset ?? null,
      targetStem: normalizedCard.targetStem,
      prompt: normalizedCard.prompt,
    };
    persistMetadata({
      ...currentMetadata,
      voiceCards: nextVoiceCards,
      deletedVoiceCards: (currentMetadata.deletedVoiceCards ?? []).filter((id) => id !== normalizedCard.id && id !== card.id),
    });
    setSelectedVoiceCard(normalizedCard);
    setVoiceCards((current) => current.map((item) => item.id === card.id ? normalizedCard : item));
  }, [persistMetadata]);

  const handleDeleteSceneCard = useCallback((card: SceneAssetCard) => {
    if (!confirm(`确定删除 "${card.title || card.targetStem || card.id}"？`)) return;
    const currentMetadata = metadataRef.current;
    const nextSceneCards = { ...(currentMetadata.sceneCards ?? {}) };
    delete nextSceneCards[card.id];
    const deletedSceneCards = Array.from(new Set([...(currentMetadata.deletedSceneCards ?? []), card.id]));
    persistMetadata({
      ...currentMetadata,
      sceneCards: nextSceneCards,
      deletedSceneCards,
    });
    if (selectedSceneCard?.id === card.id) {
      setSelectedSceneCard(null);
      setEditingSceneCard(null);
    }
  }, [persistMetadata, selectedSceneCard]);

  const handleDeleteVoiceCard = useCallback((card: VoiceAssetCard) => {
    if (!confirm(`确定删除 "${card.character || '旁白'}：${card.text}"？`)) return;
    const currentMetadata = metadataRef.current;
    const nextVoiceCards = { ...(currentMetadata.voiceCards ?? {}) };
    delete nextVoiceCards[card.id];
    const deletedVoiceCards = Array.from(new Set([...(currentMetadata.deletedVoiceCards ?? []), card.id]));
    persistMetadata({
      ...currentMetadata,
      voiceCards: nextVoiceCards,
      deletedVoiceCards,
    });
    setVoiceCards((current) => current.filter((item) => item.id !== card.id));
    if (selectedVoiceCard?.id === card.id) setSelectedVoiceCard(null);
  }, [persistMetadata, selectedVoiceCard]);

  const handleNewSceneCard = useCallback(() => {
    const id = `scene-${Date.now()}`;
    const index = Object.keys(metadataRef.current.sceneCards ?? {}).length + 1;
    const card: SceneAssetCard = {
      id,
      title: '新场景',
      sceneFile: null,
      imageAsset: null,
      targetStem: defaultSceneTargetStem(index),
      prompt: '',
      style: '',
      negativePrompt: '',
    };
    handleSaveSceneCard(card);
    setSelectedSceneCard(card);
    setEditingSceneCard(card);
    setSelectedAsset(null);
  }, [handleSaveSceneCard]);

  return (
    <div className="h-full story-shell">
      <StoryOsTopBar
        title="素材库"
        onRun={() => navigate(`/editor/${projectId}?action=preview`)}
        onPublish={() => navigate(`/editor/${projectId}?action=export`)}
      />
      <StoryOsSideNav
        active={activeTab === 'character' ? 'characters' : 'assets'}
        projectId={projectId}
        projectLabel={projectPath ? projectPath.split('/').pop() : 'ALPHA'}
        onCreate={handleImport}
      />

      {!projectPath ? (
        <div className="story-os-workspace flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p>未找到项目路径，请从编辑器重新进入素材库</p>
          </div>
        </div>
      ) : (
        <div className="story-os-workspace flex bg-surface-container-lowest">
          <main className="relative flex-1 flex flex-col overflow-hidden bg-surface">
            <div className="flex h-12 items-end gap-1 border-b border-border bg-surface-container-low px-4 pt-2">
              <button
                onClick={() => navigate(`/editor/${projectId}`)}
                className="story-os-command mb-1 mr-2 text-muted-foreground"
                aria-label="返回编辑器"
              >
                <ArrowLeft className="mr-1 inline h-3.5 w-3.5" />
                编辑器
              </button>
              {tabConfig.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setActiveTab(id); setSelectedAsset(null); }}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold tracking-wide transition-colors ${
                    activeTab === id
                      ? 'story-os-layered-tab-active text-foreground'
                      : 'rounded-t text-muted-foreground hover:bg-surface-container-highest hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                  <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">{tabCounts[id]}</span>
                </button>
              ))}
              <button
                onClick={() => {
                  if (activeTab === 'character') {
                    setCharacterGenerationRequestToken((value) => value + 1);
                    return;
                  }
                  alert(`${aiActionLabel} 即将推出`);
                }}
                className="story-os-command mb-1 ml-auto border-primary/30 bg-primary/10 text-primary"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {aiActionLabel}
              </button>
              {importConfig && (
                <button
                  onClick={handleImport}
                  disabled={!projectPath || importing}
                  className="story-os-command story-os-command-primary story-os-chamfer-tr mb-1 disabled:opacity-50"
                >
                  {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {importing ? '导入中...' : importConfig.buttonLabel}
                </button>
              )}
            </div>
            <div className="flex h-10 items-center gap-2 border-b border-border bg-surface-container-lowest px-4">
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {projectPath}
              </span>
              <button
                onClick={() => alert('文件夹浏览即将推出')}
                className="story-os-command"
                aria-label="浏览所有文件夹"
              >
                <FolderOpen className="mr-1 inline h-3.5 w-3.5" />
                所有文件夹
              </button>
              <button
                onClick={() => alert('标签管理即将推出')}
                className="story-os-command"
                aria-label="管理素材标签"
              >
                <Tag className="mr-1 inline h-3.5 w-3.5" />
                标签管理
              </button>
              <button
                onClick={() => alert('筛选器即将推出')}
                className="story-os-command"
                aria-label="使用筛选器筛选素材"
              >
                <Filter className="mr-1 inline h-3.5 w-3.5" />
                筛选器
              </button>
            </div>
            {activeTab === 'character' ? (
              <CharacterPanel
                projectPath={projectPath}
                embedded
                onCharacterCountChange={setCharacterCount}
                generationRequestToken={characterGenerationRequestToken}
                figureLibraryRefreshToken={figureLibraryRefreshToken}
              />
            ) : (
              <>
            {/* Toolbar */}
            <div className="px-4 py-3 border-b border-border bg-surface-container-lowest flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 flex-1">
                {activeTab === 'music' && (
                  <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-1 flex-shrink-0">
                    {musicTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                      onClick={() => {
                        setMusicCategory(tab.id);
                        setSelectedAsset(null);
                        setSelectedSceneCard(null);
                        setSelectedVoiceCard(null);
                      }}
                        className={`px-3 py-1.5 rounded text-xs transition-colors ${
                          musicCategory === tab.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="搜索素材名称..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-input-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-1">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-2 rounded transition-colors ${
                      viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                    }`}
                    aria-label="切换为网格视图"
                  >
                    <Grid3x3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-2 rounded transition-colors ${
                      viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                    }`}
                    aria-label="切换为列表视图"
                  >
                    <List className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div className="mx-6 mt-2 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {error}
                <button onClick={() => setError(null)} className="ml-auto text-xs underline hover:no-underline">关闭</button>
              </div>
            )}

            {/* Assets Display */}
            <div className="flex-1 overflow-auto p-4">
              {loading ? (
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : activeTab === 'scene' ? (
                sceneLibraryItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                    <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
                    <p className="text-lg mb-2">暂无场景</p>
                    <p className="text-sm">点击右上角“新建场景”开始设定背景图</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {sceneLibraryItems.map((item) => {
                      const card = item.kind === 'sceneCard' ? item.card : null;
                      const asset = item.kind === 'sceneCard' ? item.asset : item.asset;
                      const thumbnail = asset ? getThumbnail(asset) : null;
                      const title = card?.title || aliasForAsset(asset) || asset.name;
                      const subtitle = card
                        ? [card.sceneFile, card.imageAsset].filter(Boolean).join(' · ') || '尚未生成图片'
                        : asset.name;
                      const isSelected = card && !asset
                        ? selectedSceneCard?.id === card.id
                        : asset
                          ? selectedAsset?.path === asset.path
                          : false;
                      return (
                        <div
                          key={card ? `scene-${card.id}` : `asset-${asset.path}`}
                          onClick={() => {
                            if (asset) {
                              setSelectedAsset(asset);
                              setSelectedSceneCard(null);
                              setSelectedVoiceCard(null);
                              setEditingSceneCard(null);
                            } else if (card) {
                              handleEditSceneCard(card);
                            }
                          }}
                          className={`group overflow-hidden rounded-lg bg-card text-left transition-all hover:scale-[1.02] ${
                            isSelected
                              ? 'ring-2 ring-primary shadow-[0_0_20px_rgba(212,165,116,0.3)]'
                              : 'hover:ring-1 hover:ring-border'
                          }`}
                        >
                          <div className="aspect-video bg-secondary/30 relative overflow-hidden">
                            {thumbnail ? (
                              <img src={thumbnail} alt={title} className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                                <Image className="h-10 w-10 opacity-40" />
                                <span className="text-xs">未生成背景图</span>
                              </div>
                            )}
                            {(asset || card) && (
                              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (asset) {
                                      void handleDelete(asset);
                                    } else if (card) {
                                      handleDeleteSceneCard(card);
                                    }
                                  }}
                                  className="absolute right-2 top-2 p-2 rounded-full bg-destructive/90 text-destructive-foreground hover:bg-destructive transition-colors"
                                  aria-label={asset ? '删除素材' : '删除场景'}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="border-t border-border p-3">
                            <div className="truncate text-sm font-medium">{title}</div>
                            <div className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</div>
                            {card?.prompt && (
                              <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{card.prompt}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : activeTab === 'music' && musicCategory === 'vocal' ? (
                voiceLibraryItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                    <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
                    <p className="text-lg mb-2">暂无语音</p>
                    <p className="text-sm">故事编织室中出现对话后会自动生成待配音条目</p>
                  </div>
                ) : (
                  <div className={viewMode === 'grid' ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4' : 'space-y-2'}>
                    {voiceLibraryItems.map((item) => {
                      const card = item.kind === 'voiceCard' ? item.card : null;
                      const asset = item.kind === 'voiceCard' ? item.asset : item.asset;
                      const isSelected = card ? selectedVoiceCard?.id === card.id : selectedAsset?.path === asset.path;
                      const title = card
                        ? `${card.character || '旁白'}：${card.text}`
                        : aliasForAsset(asset) || asset.name;
                      const subtitle = card
                        ? `${card.emotion || '默认'} · ${card.voiceAsset || '尚未生成语音'}`
                        : `${asset.extension.toUpperCase()} · ${getAudioDurationLabel(asset.path, audioDurations, audioMetadataErrors)}`;
                      if (viewMode === 'list') {
                        return (
                          <div
                            key={card ? `voice-${card.id}` : `asset-${asset.path}`}
                            onClick={() => {
                              if (card) {
                                setSelectedVoiceCard(card);
                                setSelectedAsset(null);
                                setSelectedSceneCard(null);
                                setEditingSceneCard(null);
                              } else {
                                setSelectedAsset(asset);
                                setSelectedVoiceCard(null);
                                setSelectedSceneCard(null);
                                setEditingSceneCard(null);
                              }
                            }}
                            className={`flex items-center gap-4 p-4 rounded-lg cursor-pointer transition-all ${
                              isSelected ? 'bg-primary/10 ring-1 ring-primary' : 'bg-card/50 hover:bg-card'
                            }`}
                          >
                            <div className="w-16 h-16 rounded overflow-hidden bg-secondary/30 flex-shrink-0 flex items-center justify-center">
                              <Music className="w-6 h-6 text-muted-foreground" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-medium truncate">{title}</h3>
                              <p className="text-sm text-muted-foreground truncate">{subtitle}</p>
                              {asset && (audioProgress[asset.path] ?? 0) > 0 && (
                                <div className="mt-2 h-1 rounded bg-secondary overflow-hidden">
                                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.min((audioProgress[asset.path] ?? 0) * 100, 100)}%` }} />
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {card && (
                                <span className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">{card.emotion || '默认'}</span>
                              )}
                              {card && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteVoiceCard(card);
                                  }}
                                  className="p-2 rounded-full hover:bg-destructive/10 transition-colors"
                                  aria-label="删除语音"
                                >
                                  <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                                </button>
                              )}
                              {asset && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                                  className="p-2 rounded-full hover:bg-secondary transition-colors"
                                  aria-label="切换音频播放"
                                >
                                  {playingAudio === asset.path ? (
                                    <Pause className="w-4 h-4" />
                                  ) : (
                                    <Play className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={card ? `voice-${card.id}` : `asset-${asset.path}`}
                          onClick={() => {
                            if (card) {
                              setSelectedVoiceCard(card);
                              setSelectedAsset(null);
                              setSelectedSceneCard(null);
                              setEditingSceneCard(null);
                            } else {
                              setSelectedAsset(asset);
                              setSelectedVoiceCard(null);
                              setSelectedSceneCard(null);
                              setEditingSceneCard(null);
                            }
                          }}
                          className={`group relative rounded-lg overflow-hidden cursor-pointer transition-all hover:scale-[1.02] ${
                            isSelected
                              ? 'ring-2 ring-primary shadow-[0_0_20px_rgba(212,165,116,0.3)]'
                              : 'hover:ring-1 hover:ring-border bg-card'
                          }`}
                        >
                          <div className="aspect-square bg-secondary/30 relative overflow-hidden flex flex-col items-center justify-center gap-4">
                            <Music className="w-10 h-10 text-muted-foreground" />
                            <div className="w-2/3 h-8 rounded overflow-hidden bg-[repeating-linear-gradient(90deg,hsl(var(--primary)/0.25)_0_3px,transparent_3px_7px)]" />
                            {(asset || card) && (
                              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="absolute right-2 top-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (asset) {
                                        void handleDelete(asset);
                                      } else if (card) {
                                        handleDeleteVoiceCard(card);
                                      }
                                    }}
                                    className="p-2 rounded-full bg-destructive/90 text-destructive-foreground hover:bg-destructive transition-colors"
                                    aria-label={asset ? '删除素材' : '删除语音'}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                                {asset && (
                                  <div className="absolute bottom-0 left-0 right-0 p-3 flex gap-2">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                                      className="p-2 rounded-full bg-primary/90 hover:bg-primary transition-colors"
                                      aria-label="切换音频播放"
                                    >
                                      {playingAudio === asset.path ? (
                                        <Pause className="w-3 h-3 text-primary-foreground" />
                                      ) : (
                                        <Play className="w-3 h-3 text-primary-foreground" />
                                      )}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="p-3 bg-card border-t border-border">
                            <h3 className="text-sm font-medium truncate mb-1">{title}</h3>
                            <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : filteredAssets.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                  <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
                  <p className="text-lg mb-2">暂无素材</p>
                  <p className="text-sm">点击右上角“{importConfig?.buttonLabel ?? 'AI 生成'}”开始添加</p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className={`grid gap-4 ${
                  activeTab === 'scene'
                    ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
                    : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
                }`}>
                  {filteredAssets.map((asset) => {
                    const thumbnail = getThumbnail(asset);
                    const isSelected = selectedAsset?.path === asset.path;
                    const progress = audioProgress[asset.path] ?? 0;
                    const hasAudioDuration = audioDurations[asset.path] !== undefined;
                    const hasAudioMetadataError = audioMetadataErrors[asset.path] === true;
                    return (
                      <div
                        key={asset.path}
                        onClick={() => setSelectedAsset(asset)}
                        className={`story-os-interactive group relative cursor-pointer overflow-hidden rounded border bg-surface-container-low ${
                          isSelected
                            ? 'border-secondary ring-1 ring-secondary story-os-hard-shadow'
                            : 'border-border hover:border-secondary'
                        }`}
                      >
                        <div className={`${activeTab === 'scene' ? 'aspect-video' : 'aspect-square'} story-os-blueprint bg-surface-dim relative overflow-hidden`}>
                          {thumbnail ? (
                            <img
                              src={thumbnail}
                              alt={asset.name}
                              className="w-full h-full object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
                              {isAudioExt(asset.extension) ? (
                                <>
                                  <Music className="w-10 h-10 text-muted-foreground" />
                                  <div className="w-2/3 h-8 rounded overflow-hidden bg-[repeating-linear-gradient(90deg,hsl(var(--primary)/0.25)_0_3px,transparent_3px_7px)]" />
                                </>
                              ) : (
                                <Image className="w-12 h-12 text-muted-foreground/30" />
                              )}
                            </div>
                          )}
                          {isAudioExt(asset.extension) && progress > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-background/50">
                              <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="absolute right-2 top-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDelete(asset);
                                }}
                                className="p-2 rounded-full bg-destructive/90 text-destructive-foreground hover:bg-destructive transition-colors"
                                aria-label="删除素材"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 p-3 flex gap-2">
                              {isAudioExt(asset.extension) && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                                  className="p-2 rounded-full bg-primary/90 hover:bg-primary transition-colors"
                                  aria-label="切换音频播放"
                                >
                                  {playingAudio === asset.path ? (
                                    <Pause className="w-3 h-3 text-primary-foreground" />
                                  ) : (
                                    <Play className="w-3 h-3 text-primary-foreground" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="p-2 bg-surface-container-lowest border-t border-border">
                          <h3 className="text-sm font-medium truncate mb-1">{aliasForAsset(asset) || asset.name}</h3>
                          {aliasForAsset(asset) && (
                            <div className="mb-1 truncate text-[11px] text-muted-foreground font-mono-family">{asset.name}</div>
                          )}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{asset.extension.toUpperCase()}</span>
                            {isAudioExt(asset.extension) && (
                              <span>{getAudioDurationLabel(asset.path, audioDurations, audioMetadataErrors)}</span>
                            )}
                            <span>{formatSize(asset.size)}</span>
                          </div>
                          {!isAudioExt(asset.extension) && (
                            <div className="mt-1 flex items-center gap-1 text-[11px] text-secondary/80">
                              <Eye className="h-3 w-3" />
                              <span>Used in {countUsages(assetUsages, asset.name)} scene{countUsages(assetUsages, asset.name) === 1 ? '' : 's'}</span>
                            </div>
                          )}
                          {isAudioExt(asset.extension) && !hasAudioDuration && !hasAudioMetadataError && (
                            <audio
                              preload="metadata"
                              src={convertFileSrc(asset.path)}
                              onLoadedMetadata={(event) => {
                                const duration = getSafeAudioDuration(event.currentTarget);
                                setAudioDurations((prev) => ({ ...prev, [asset.path]: duration }));
                                setAudioMetadataErrors((prev) => {
                                  if (!prev[asset.path]) return prev;
                                  const next = { ...prev };
                                  delete next[asset.path];
                                  return next;
                                });
                              }}
                              onError={() => {
                                setAudioMetadataErrors((prev) => ({ ...prev, [asset.path]: true }));
                              }}
                              className="hidden"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredAssets.map((asset) => {
                    const thumbnail = getThumbnail(asset);
                    const isSelected = selectedAsset?.path === asset.path;
                    const progress = audioProgress[asset.path] ?? 0;
                    const hasAudioDuration = audioDurations[asset.path] !== undefined;
                    const hasAudioMetadataError = audioMetadataErrors[asset.path] === true;
                    return (
                      <div
                        key={asset.path}
                        onClick={() => setSelectedAsset(asset)}
                        className={`story-os-interactive flex cursor-pointer items-center gap-4 rounded border p-4 ${
                          isSelected
                            ? 'bg-secondary/10 border-secondary'
                            : 'bg-surface-container-lowest border-border hover:border-secondary'
                        }`}
                      >
                        <div className="w-16 h-16 rounded overflow-hidden bg-secondary/30 flex-shrink-0">
                          {thumbnail ? (
                            <img src={thumbnail} alt={asset.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              {isAudioExt(asset.extension) ? (
                                <Music className="w-6 h-6 text-muted-foreground" />
                              ) : (
                                <Image className="w-6 h-6 text-muted-foreground/30" />
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium truncate">{aliasForAsset(asset) || asset.name}</h3>
                          <p className="text-sm text-muted-foreground">
                            {aliasForAsset(asset) ? `${asset.name} · ` : ''}{formatCategory(asset.category)} · {asset.extension.toUpperCase()} · {isAudioExt(asset.extension) ? `${getAudioDurationLabel(asset.path, audioDurations, audioMetadataErrors)} · ` : ''}{formatSize(asset.size)}
                          </p>
                          {isAudioExt(asset.extension) && progress > 0 && (
                            <div className="mt-2 h-1 rounded bg-secondary overflow-hidden">
                              <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
                            </div>
                          )}
                          {!isAudioExt(asset.extension) && (
                            <div className="mt-1 flex items-center gap-1 text-[11px] text-secondary/80">
                              <Eye className="h-3 w-3" />
                              <span>Used in {countUsages(assetUsages, asset.name)} scene{countUsages(assetUsages, asset.name) === 1 ? '' : 's'}</span>
                            </div>
                          )}
                          {isAudioExt(asset.extension) && !hasAudioDuration && !hasAudioMetadataError && (
                            <audio
                              preload="metadata"
                              src={convertFileSrc(asset.path)}
                              onLoadedMetadata={(event) => {
                                const duration = getSafeAudioDuration(event.currentTarget);
                                setAudioDurations((prev) => ({ ...prev, [asset.path]: duration }));
                                setAudioMetadataErrors((prev) => {
                                  if (!prev[asset.path]) return prev;
                                  const next = { ...prev };
                                  delete next[asset.path];
                                  return next;
                                });
                              }}
                              onError={() => {
                                setAudioMetadataErrors((prev) => ({ ...prev, [asset.path]: true }));
                              }}
                              className="hidden"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{asset.extension.toUpperCase()}</span>
                          {isAudioExt(asset.extension) && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handlePlayToggle(asset.path); }}
                              className="p-2 rounded-full hover:bg-secondary transition-colors"
                              aria-label="切换音频播放"
                            >
                              {playingAudio === asset.path ? (
                                <Pause className="w-4 h-4" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
              </>
            )}

            {activeTab !== 'character' && (
              <div className="pointer-events-none absolute bottom-3 left-4 right-4 z-10 flex items-center justify-between rounded border border-border bg-surface-container-lowest/90 px-3 py-2 shadow-sm backdrop-blur">
                <div className="flex items-center gap-3">
                  <span className="border-r border-border pr-3 font-mono-family text-[10px] font-semibold tracking-widest text-on-surface-variant">
                    ASSET TOOLBOX
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => runAssetTool('compress')}
                      className="flex items-center gap-1 rounded border border-border bg-surface-bright px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:border-secondary"
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                      资源压缩
                    </button>
                    <button
                      type="button"
                      onClick={() => runAssetTool('validate')}
                      className="flex items-center gap-1 rounded border border-border bg-surface-bright px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:border-secondary"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      素材校验
                    </button>
                    <button
                      type="button"
                      onClick={() => runAssetTool('convert')}
                      className="flex items-center gap-1 rounded border border-border bg-surface-bright px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:border-secondary"
                    >
                      <Shuffle className="h-3.5 w-3.5" />
                      转为 WEBP
                    </button>
                    <button
                      type="button"
                      onClick={() => runAssetTool('purge')}
                      className="flex items-center gap-1 rounded border border-border bg-surface-bright px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:border-secondary"
                    >
                      <Eraser className="h-3.5 w-3.5" />
                      清理未使用
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 font-mono-family text-[10px] text-muted-foreground">
                  <HardDrive className="h-3.5 w-3.5" />
                  <span>
                    Storage: {formatSize(totalStorageBytes)} / {formatSize(storageQuotaBytes)}
                  </span>
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-variant">
                    <div
                      className={`h-full ${storagePercent > 80 ? 'bg-error' : 'bg-primary'}`}
                      style={{ width: `${storagePercent}%` }}
                    />
                  </div>
                  <span>{storagePercent}%</span>
                </div>
              </div>
            )}
          </main>

          {/* Right Sidebar - Details */}
          {activeTab !== 'character' && (
          <aside className="my-4 mr-4 w-80 overflow-hidden rounded border border-border bg-surface-bright/90 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] backdrop-blur-xl">
            {selectedAsset ? (
              <div className="h-full overflow-auto">
                <div className="flex h-10 items-center justify-between border-b border-border bg-surface-container-high px-4">
                  <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">属性检视器</span>
                  <button type="button" onClick={() => setSelectedAsset(null)} className="text-muted-foreground hover:text-foreground" aria-label="关闭素材详情">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              <div className="p-4">
                <div className="mb-6">
                  <div className="story-os-blueprint story-os-hard-shadow aspect-video rounded overflow-hidden bg-surface-dim mb-4 border border-border">
                    {getThumbnail(selectedAsset) ? (
                      <img
                        src={getThumbnail(selectedAsset)!}
                        alt={selectedAsset.name}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        {isAudioExt(selectedAsset.extension) ? (
                          <Music className="w-16 h-16 text-muted-foreground" />
                        ) : (
                          <Image className="w-16 h-16 text-muted-foreground/30" />
                        )}
                      </div>
                    )}
                  </div>
                  <h2 className="text-xl mb-2 font-display-family">
                    {selectedAsset.name}
                  </h2>
                  <p className="text-xs text-muted-foreground truncate font-mono-family">
                    {selectedAsset.path}
                  </p>
                </div>

                <div className="space-y-4 mb-6">
                  {(activeTab === 'scene' || activeTab === 'music') && (
                    <div>
                      <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                        显示名称
                      </label>
                      <input
                        type="text"
                        value={aliasForAsset(selectedAsset)}
                        onChange={(e) => handleAliasChange(selectedAsset, e.target.value)}
                        className="w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                        placeholder={activeTab === 'scene' ? '例：教室 · 白天' : '例：悲伤主旋律'}
                        aria-label="素材显示名称"
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        设置后，剧本编辑器的素材选择弹窗会优先显示这个名称。
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                      文件信息
                    </label>
                    <div className="space-y-0 text-sm">
                      <div className="flex justify-between border-b border-border/40 py-2">
                        <span className="text-muted-foreground">类型</span>
                        <span>{formatCategory(selectedAsset.category)}</span>
                      </div>
                      <div className="flex justify-between border-b border-border/40 py-2">
                        <span className="text-muted-foreground">格式</span>
                        <span>{selectedAsset.extension.toUpperCase()}</span>
                      </div>
                      <div className="flex justify-between border-b border-border/40 py-2">
                        <span className="text-muted-foreground">大小</span>
                        <span>{formatSize(selectedAsset.size)}</span>
                      </div>
                    </div>
                  </div>

                  {activeTab === 'scene' && (
                    <div>
                      <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                        场景标签
                      </label>
                      <div className="space-y-3">
                        {sceneTagGroups.map((group) => (
                          <div key={group.title}>
                            <div className="mb-1 text-[10px] text-muted-foreground">{group.title}</div>
                            <div className="flex flex-wrap gap-2">
                              {group.tags.map((tagName) => {
                                const active = tagsForAsset(selectedAsset).includes(tagName);
                                return (
                                  <button
                                    key={tagName}
                                    type="button"
                                    onClick={() => toggleTag(selectedAsset, tagName)}
                                    className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                                      active
                                        ? 'bg-primary/20 text-primary border-primary/30'
                                        : 'bg-secondary/40 border-border hover:bg-secondary'
                                    }`}
                                  >
                                    {tagName}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs uppercase tracking-wide text-muted-foreground">
                        {activeTab === 'music' ? '参考音频' : '参考图'}
                      </label>
                      <button
                        type="button"
                        onClick={handleReferenceUpload}
                        disabled={referenceUploading}
                        className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs flex items-center gap-1 disabled:opacity-50"
                      >
                        {referenceUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                        上传
                      </button>
                    </div>
                    <div className="space-y-2">
                      {referencesForAsset(selectedAsset).length === 0 ? (
                        <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">暂无参考资料。</div>
                      ) : referencesForAsset(selectedAsset).map((filename) => {
                        const sourcePath = referenceFilePath(projectPath, selectedAsset.category, selectedAsset.name, filename);
                        if (!sourcePath) return null;
                        return (
                          <div key={filename} className="flex items-center gap-2 rounded-md bg-secondary/20 p-2">
                            {selectedAsset.category !== 'background' ? (
                              <audio controls src={convertFileSrc(sourcePath)} className="min-w-0 flex-1 h-8" />
                            ) : (
                              <img src={convertFileSrc(sourcePath)} alt="" className="w-10 h-10 rounded object-cover bg-secondary" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs font-mono-family">{filename}</span>
                            <button
                              type="button"
                              onClick={() => handleReferenceRemove(filename)}
                              className="p-1 rounded hover:bg-destructive/10"
                              aria-label="删除参考资料"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                      描述
                    </label>
                    <textarea
                      value={descriptionForAsset(selectedAsset)}
                      onChange={(e) => handleDescriptionChange(selectedAsset, e.target.value)}
                      rows={6}
                      placeholder={activeTab === 'scene'
                        ? '描述要生成或重绘的背景：地点、时间、天气、氛围、镜头角度、画面主体。'
                        : '描述要生成的音频：情绪、节奏、乐器、用途或台词内容。'}
                      className="w-full resize-y rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>

                  <div>
                    <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
                      剧本引用
                    </label>
                    <div className="space-y-2">
                      {assetUsages.length === 0 ? (
                        <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">未在剧本中找到引用。</div>
                      ) : assetUsages.map((usage, index) => (
                        <button
                          key={`${usage.sceneFile}-${usage.lineNumber}-${index}`}
                          type="button"
                          onClick={() => openUsage(usage)}
                          className="w-full rounded-md bg-secondary/20 p-2 text-left hover:bg-primary/10 transition-colors"
                        >
                          <div className="text-xs text-primary">{usage.sceneFile} 第 {usage.lineNumber} 行</div>
                          <div className="mt-1 truncate text-[10px] text-muted-foreground font-mono-family">{usage.lineContent}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={handleRename}
                    className="w-full px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-all flex items-center justify-center gap-2"
                    aria-label="重命名素材"
                  >
                    <Edit3 className="w-4 h-4" />
                    重命名
                  </button>
                  <button
                    onClick={() => handleGenerateFromAsset(selectedAsset)}
                    className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2"
                    aria-label="AI 生成"
                  >
                    <Sparkles className="w-4 h-4" />
                    AI 生成
                  </button>
                </div>
              </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <Image className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-sm">选择一个素材查看详情</p>
              </div>
            )}
          </aside>
          )}
        </div>
      )}
      <AssetAiGenerateDialog
        open={aiGenerateOpen}
        activeTab={activeTab}
        musicCategory={musicCategory}
        initialSceneCard={editingSceneCard}
        initialVoiceCard={selectedVoiceCard}
        initialAssetPrompt={aiAssetPrompt}
        onClose={() => setAiGenerateOpen(false)}
      />
      <audio
        ref={audioRef}
        onEnded={() => setPlayingAudio(null)}
        onError={() => {
          const current = playingAudio;
          if (current) {
            setAudioMetadataErrors((prev) => ({ ...prev, [current]: true }));
            setError('当前音频无法解码或播放，请尝试转换为常规 MP3/WAV/Ogg 后重新导入。');
          }
          setPlayingAudio(null);
        }}
        onLoadedMetadata={(event) => {
          if (!playingAudio) return;
          const duration = getSafeAudioDuration(event.currentTarget);
          setAudioDurations((prev) => ({ ...prev, [playingAudio]: duration }));
        }}
        onTimeUpdate={(event) => {
          if (!playingAudio) return;
          const { currentTime } = event.currentTarget;
          const duration = getSafeAudioDuration(event.currentTarget);
          setAudioProgress((prev) => ({ ...prev, [playingAudio]: duration ? currentTime / duration : 0 }));
        }}
        className="hidden"
        aria-label="音频播放器"
      />
    </div>
  );
}

function AssetAiGenerateDialog({
  open,
  activeTab,
  musicCategory,
  initialSceneCard,
  initialVoiceCard,
  initialAssetPrompt,
  onClose,
}: {
  open: boolean;
  activeTab: TabId;
  musicCategory: MusicCategory;
  initialSceneCard?: SceneAssetCard | null;
  initialVoiceCard?: VoiceAssetCard | null;
  initialAssetPrompt?: string;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<AiProviderConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isImageGeneration = activeTab === 'scene';
  const title = isImageGeneration ? 'AI 生成背景素材' : `AI 生成${musicCategoryLabels[musicCategory]}`;
  const configuredModels = config ? parseConfiguredModels(config.model) : [];
  const effectiveModel = selectedModel || configuredModels[0] || config?.model.trim() || '';
  const promptSource = isImageGeneration
    ? initialSceneCard?.prompt.trim() ?? ''
    : musicCategory === 'vocal'
      ? [
          initialVoiceCard?.text.trim(),
          initialVoiceCard?.character ? `角色：${initialVoiceCard.character}` : '',
          initialVoiceCard?.emotion ? `情绪：${initialVoiceCard.emotion}` : '',
          initialVoiceCard?.prompt.trim(),
        ].filter(Boolean).join('\n')
      : (initialAssetPrompt ?? '').trim();
  const targetCategory = isImageGeneration ? 'background' : musicCategory;
  const targetFilename = isImageGeneration
    ? `${initialSceneCard?.targetStem || initialSceneCard?.imageAsset?.replace(/\.[^.]+$/, '') || 'generated_background'}.webp`
    : musicCategory === 'vocal'
      ? initialVoiceCard?.voiceAsset || `${initialVoiceCard?.targetStem || initialVoiceCard?.id || 'generated_voice'}.wav`
      : `generated_${musicCategory}.wav`;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoadingConfig(true);
    (isImageGeneration ? getAiImageConfig() : getAiTtsConfig())
      .then((nextConfig) => {
        setConfig(nextConfig);
        const models = parseConfiguredModels(nextConfig.model);
        setSelectedModel(models[0] ?? nextConfig.model.trim());
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingConfig(false));
  }, [initialSceneCard, initialVoiceCard, isImageGeneration, musicCategory, open]);

  if (!open) return null;

  const handleSubmit = () => {
    if (!config) {
      setError('未读取到 AI 配置。');
      return;
    }
    if (!effectiveModel) {
      setError(isImageGeneration ? '请先在图片 AI 设置中选择至少一个模型。' : '请先在音频 AI 设置中选择至少一个模型。');
      return;
    }
    if (!promptSource.trim()) {
      setError(isImageGeneration ? '请先在右侧详情里填写描述。' : '请先在右侧详情里填写台词或描述。');
      return;
    }
    setError(`生成接口还未接入。当前已选择模型：${effectiveModel || config.model || '未填写模型'}。生成结果将保存到 game/${targetCategory}/${targetFilename}。`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[680px] max-h-[86vh] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-display-family">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm hover:bg-secondary/60"
          >
            关闭
          </button>
        </div>

        <div className="max-h-[calc(86vh-120px)] overflow-y-auto p-4 space-y-4">
          <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
            {loadingConfig
              ? '正在读取 AI 配置...'
              : config
                ? `使用配置：${config.provider} / ${effectiveModel || '未填写模型'}`
                : '未读取到配置'}
          </div>

          <FieldBlock label="生成模型">
            {configuredModels.length > 1 ? (
              <select
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {configuredModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder={isImageGeneration ? '先在图片 AI 设置中选择模型' : '先在音频 AI 设置中选择模型'}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            )}
          </FieldBlock>

          {promptSource.trim() ? (
            <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
              将使用右侧详情中的描述、台词和情绪作为生成提示词。
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              右侧详情还没有可用于生成的描述。
            </div>
          )}

          <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground font-mono-family break-all">
            game/{targetCategory}/{targetFilename}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-secondary px-4 py-2 text-sm hover:bg-secondary/70"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
          >
            生成素材
          </button>
        </div>
      </div>
    </div>
  );
}

function parseConfiguredModels(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

function VoiceCardDetails({
  card,
  projectPath,
  onSave,
  onGenerate,
  onOpenUsage,
}: {
  card: VoiceAssetCard;
  projectPath: string;
  onSave: (card: VoiceAssetCard) => void;
  onGenerate: (card: VoiceAssetCard) => void;
  onOpenUsage: (usage: AssetUsage) => void;
}) {
  const [draft, setDraft] = useState<VoiceAssetCard>(card);

  useEffect(() => {
    setDraft(card);
  }, [card]);

  const targetStem = draft.targetStem || draft.voiceAsset?.replace(/\.[^.]+$/, '') || draft.id;
  const targetFilename = draft.voiceAsset || `${targetStem}.wav`;
  const targetPath = projectPath ? `${projectPath}\\game\\vocal\\${targetFilename}` : targetFilename;
  const update = (patch: Partial<VoiceAssetCard>) => setDraft((current) => ({ ...current, ...patch }));

  const handleRenameVoice = () => {
    const currentStem = targetStem.replace(/\.(mp3|ogg|wav|flac|aac)$/i, '');
    const nextStem = prompt('输入新名称:', currentStem);
    if (!nextStem || nextStem === currentStem) return;
    const normalizedStem = nextStem.replace(/\.(mp3|ogg|wav|flac|aac)$/i, '');
    const next = { ...draft, targetStem: normalizedStem };
    setDraft(next);
    onSave(next);
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="aspect-square rounded-lg overflow-hidden bg-secondary/30 mb-4 flex flex-col items-center justify-center gap-4">
          <Music className="w-16 h-16 text-muted-foreground" />
          <div className="w-2/3 h-8 rounded overflow-hidden bg-[repeating-linear-gradient(90deg,hsl(var(--primary)/0.25)_0_3px,transparent_3px_7px)]" />
        </div>
        <h2 className="text-xl mb-2 font-display-family">
          {targetFilename}
        </h2>
        <p className="text-xs text-muted-foreground truncate font-mono-family">
          {targetPath}
        </p>
      </div>

      <div className="space-y-4 mb-6">
        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            显示名称
          </label>
          <input
            type="text"
            value={`${draft.character || '旁白'}：${draft.text}`}
            readOnly
            className="w-full px-3 py-2 bg-input-background border border-border rounded-md text-sm"
            aria-label="语音显示名称"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            相同角色、台词和情绪会复用同一条语音。
          </p>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            角色
          </label>
          <input
            value={draft.character}
            onChange={(e) => update({ character: e.target.value })}
            className="w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
            placeholder="例：Alice"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            情绪
          </label>
          <select
            value={draft.emotion || '默认'}
            onChange={(e) => update({ emotion: e.target.value })}
            className="w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
          >
            {voiceEmotionOptions.map((emotion) => (
              <option key={emotion} value={emotion}>{emotion}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            台词文本
          </label>
          <textarea
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            rows={4}
            className="w-full resize-y rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            描述
          </label>
          <textarea
            value={draft.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            rows={5}
            placeholder="描述要生成的角色语音：情绪、语气、语速、音色、停顿。"
            className="w-full resize-y rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            剧本引用
          </label>
          <div className="space-y-2">
            {(draft.usages ?? []).length === 0 ? (
              <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">未在剧本中找到引用。</div>
            ) : (draft.usages ?? []).map((usage, index) => (
              <button
                key={`${usage.sceneFile}-${usage.lineNumber}-${index}`}
                type="button"
                onClick={() => onOpenUsage(usage)}
                className="w-full rounded-md bg-secondary/20 p-2 text-left hover:bg-primary/10 transition-colors"
              >
                <div className="text-xs text-primary">{usage.sceneFile} 第 {usage.lineNumber} 行</div>
                <div className="mt-1 truncate text-[10px] text-muted-foreground font-mono-family">{usage.lineContent}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleRenameVoice}
          className="w-full px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-all flex items-center justify-center gap-2"
        >
          <Edit3 className="w-4 h-4" />
          重命名
        </button>
        <button
          type="button"
          onClick={() => onGenerate(draft)}
          className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          AI 生成
        </button>
      </div>
    </div>
  );
}

function SceneCardDetails({
  card,
  projectPath,
  backgroundAssets,
  getThumbnail,
  onSave,
  onGenerate,
}: {
  card: SceneAssetCard;
  projectPath: string;
  backgroundAssets: AssetInfo[];
  getThumbnail: (asset: AssetInfo) => string | null;
  onSave: (card: SceneAssetCard) => void;
  onGenerate: (card: SceneAssetCard) => void;
}) {
  const [draft, setDraft] = useState<SceneAssetCard>(card);

  useEffect(() => {
    setDraft({ ...card, targetStem: card.targetStem || card.imageAsset?.replace(/\.[^.]+$/, '') || card.id });
  }, [card]);

  const previewAsset = backgroundAssets.find((asset) => asset.name === draft.imageAsset) ?? null;
  const previewUrl = previewAsset ? getThumbnail(previewAsset) : null;
  const targetStem = draft.targetStem || draft.imageAsset?.replace(/\.[^.]+$/, '') || draft.id;
  const targetFilename = `${targetStem}.webp`;
  const targetPath = projectPath ? `${projectPath}\\game\\background\\${targetFilename}` : targetFilename;

  const update = (patch: Partial<SceneAssetCard>) => setDraft((current) => ({ ...current, ...patch }));
  const handleRenameScene = () => {
    const currentStem = targetStem.replace(/\.(png|jpe?g|webp)$/i, '');
    const nextStem = prompt('输入新名称:', currentStem);
    if (!nextStem || nextStem === currentStem) return;
    const normalizedStem = nextStem.replace(/\.(png|jpe?g|webp)$/i, '');
    const next = { ...draft, targetStem: normalizedStem };
    setDraft(next);
    onSave(next);
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="aspect-video rounded-lg overflow-hidden bg-secondary/30 mb-4">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={draft.title}
              className="h-full w-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Image className="h-14 w-14 opacity-40" />
              <span className="text-xs">未生成背景图</span>
            </div>
          )}
        </div>
        <h2 className="text-xl mb-2 font-display-family">
          {targetFilename}
        </h2>
        <p className="text-xs text-muted-foreground truncate font-mono-family">
          {targetPath}
        </p>
      </div>

      <div className="space-y-4 mb-6">
        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            显示名称
          </label>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
            className="w-full px-3 py-2 bg-input-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
            placeholder="例：教室 · 白天"
            aria-label="场景显示名称"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            设置后，剧本编辑器的素材选择弹窗会优先显示这个名称。
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">
              参考图
            </label>
          </div>
          <select
            value={draft.imageAsset ?? ''}
            onChange={(e) => update({ imageAsset: e.target.value || null })}
            className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">暂无参考资料。</option>
            {backgroundAssets.map((asset) => (
              <option key={asset.path} value={asset.name}>{asset.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            描述
          </label>
          <textarea
            value={draft.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            rows={6}
            placeholder="描述要生成或重绘的背景：地点、时间、天气、氛围、镜头角度、画面主体。"
            className="w-full resize-y rounded-md border border-border bg-input-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-muted-foreground block mb-2">
            剧本引用
          </label>
          <div className="space-y-2">
            {draft.sceneFile ? (
              <div className="rounded-md bg-secondary/20 p-2 text-left">
                <div className="text-xs text-primary">{draft.sceneFile}</div>
                <div className="mt-1 truncate text-[10px] text-muted-foreground font-mono-family">新场景生成后可在剧本中引用。</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">未在剧本中找到引用。</div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleRenameScene}
          className="w-full px-4 py-2 rounded-md bg-secondary hover:bg-secondary/70 transition-all flex items-center justify-center gap-2"
        >
          <Edit3 className="w-4 h-4" />
          重命名
        </button>
        <button
          type="button"
          onClick={() => onGenerate(draft)}
          className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all flex items-center justify-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          AI 生成
        </button>
      </div>
    </div>
  );
}

function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
