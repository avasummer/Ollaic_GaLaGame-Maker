import { useState, useCallback, useEffect, useRef, useMemo, Fragment } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import {
  Image, Search, Plus, Send, X,
  FileText, FolderOpen, Loader2,
  MessageCircle, GitBranch, Users, Music, Wand2, ArrowRight,
  GripVertical, MoreHorizontal, Copy, Trash2, Clipboard, Scissors,
  ZoomIn, ZoomOut, Maximize2, BookOpen, CornerDownRight, Split,
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AppSettingsDialog, loadAppSettings } from './AppSettingsDialog';
import { ProjectMetadataDialog, type ExportTaskState } from './ProjectMetadataDialog';
import { SnapshotManagerDialog } from './SnapshotManagerDialog';
import { SceneManagerPanel } from './SceneManagerPanel';
import type { WebGalNode, WebGalCommandType, SceneLink } from '../lib/webgal-types';
import { extractSceneLinks, commandCategories, commandLabels, categoryLabels } from '../lib/webgal-types';
import {
  parseScene, serializeScene, saveScene, loadScene,
  openProject, getScenePath, createScene,
  exportProject, readProjectMetadata, saveProjectMetadata,
  createProjectSnapshot, listProjectSnapshots, renameProjectSnapshot, deleteProjectSnapshot, restoreProjectSnapshot,
  setRuntimeProject, setRuntimeTemplateDir, getRuntimeUrl, jumpToSentence, openInBrowser,
  readFileText, parseSceneHeader, deleteScene, renameScene,
  type ProjectInfo, type SceneHeader, type ProjectMetadata, type SnapshotInfo,
} from '../lib/webgal-ipc';
import { listCharacters, listCharacterNames } from '../lib/character-ipc';
import type { Character } from '../lib/character-types';
import { characterColor } from '../lib/character-editing';
import { useAiAgent } from '../hooks/useAiAgent';
import { insertSceneNode, reorderSceneNodes, pasteSceneNode } from '../lib/scene-editing';
import { AiMemoryPanel } from './AiMemoryPanel';
import { AiMessageBubble } from './AiMessageBubble';
import { AiPendingCard } from './AiPendingCard';
import { ConflictCard, ErrorCard, MissingAssetCard } from './AiStatusCard';
import { DetailPanel } from './DetailPanel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { StoryOsSideNav, StoryOsTopBar } from './StoryOsChrome';
import { PerformanceTimeline } from './PerformanceTimeline';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEMO_SCRIPT = `; 序章 - 安静的午后
changeBg:afternoon_park.webp -next;
bgm:peaceful_afternoon.mp3;
changeFigure:girl_smile.webp -left -next;
setAnimation:enter-from-left -target=fig-left -next;
未知少女:你好，我是……;
未知少女:你也是这个学校的学生吗？;
:一阵微风穿过庭院。;
choose:打招呼:branch_friendly.txt|保持沉默:branch_silent.txt;
`;

const EMPTY_PROJECT_METADATA: ProjectMetadata = {
  synopsis: '',
  description: '',
  coverPath: '',
  tags: [],
  version: '0.1.0',
  releaseNotes: '',
  lastExportDir: '',
};

const IDLE_EXPORT_TASK: ExportTaskState = {
  status: 'idle',
  warnings: [],
  issues: [],
  failureCount: 0,
};

function getCommandSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content || '(空对白)'}` : node.content || '(空对白)';
    case 'narrator':
      return node.content || '(空旁白)';
    case 'choose':
      return node.choices?.map((choice) => `${choice.text} -> ${choice.target}`).join(' / ') || node.content || '(空选项)';
    case 'changeBg':
    case 'changeFigure':
    case 'miniAvatar':
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content || '未选择素材';
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content || '未选择场景';
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content || '未命名标签';
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue ?? ''}` : node.content || '未设置变量';
    case 'setAnimation':
      return `${node.animationName || node.content || '未设置动画'}${node.animationTarget ? ` -> ${node.animationTarget}` : ''}`;
    case 'intro':
      return node.introLines?.join(' / ') || node.content || '(空黑屏文字)';
    case 'end':
      return '场景结束';
    default:
      return node.content || '—';
  }
}

function commandIconFor(type: WebGalCommandType) {
  switch (type) {
    case 'dialogue':
      return MessageCircle;
    case 'choose':
      return GitBranch;
    case 'changeBg':
      return Image;
    case 'changeFigure':
    case 'miniAvatar':
      return Users;
    case 'bgm':
    case 'playEffect':
      return Music;
    case 'setAnimation':
    case 'setTransform':
      return Wand2;
    case 'changeScene':
    case 'callScene':
      return ArrowRight;
    default:
      return FileText;
  }
}

function commandToneFor(type: WebGalCommandType): string {
  switch (type) {
    case 'dialogue':
      return 'text-primary';
    case 'choose':
      return 'text-tertiary';
    case 'changeBg':
      return 'text-secondary';
    case 'bgm':
    case 'playEffect':
      return 'text-tertiary';
    default:
      return 'text-on-surface-variant';
  }
}

interface SceneWorldlinePanelProps {
  scenes: string[];
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  sceneLinkMap: Record<string, SceneLink[]>;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onOpenScene: (sceneName: string) => void;
  onOpenSceneManager?: () => void;
  characterColors?: Record<string, string>;
  nodePositions?: Record<string, { x: number; y: number }>;
  onUpdateNodePosition?: (sceneName: string, x: number, y: number) => void;
  onAddSceneLink?: (fromScene: string, toScene: string) => void;
  onRemoveSceneLink?: (fromScene: string, toScene: string, kind: SceneLink['kind']) => void;
}

interface WorldNodeLayout {
  scene: string;
  column: number;
  row: number;
  x: number;
  y: number;
  kind: 'start' | 'choice' | 'branch' | 'orphan';
  outgoing: SceneLink[];
  incoming: number;
  isCurrent: boolean;
  isOrphan: boolean;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 78;
const COLUMN_GAP = 96;
const ROW_GAP = 32;
const PADDING = 32;

function buildWorldLayout(
  scenes: string[],
  currentSceneName: string,
  sceneLinkMap: Record<string, SceneLink[]>,
): { nodes: WorldNodeLayout[]; width: number; height: number } {
  const incomingCount: Record<string, number> = {};
  for (const links of Object.values(sceneLinkMap)) {
    for (const link of links) {
      if (!link.target) continue;
      incomingCount[link.target] = (incomingCount[link.target] ?? 0) + 1;
    }
  }

  const visited = new Set<string>();
  const columns: string[][] = [];
  const queue: Array<{ scene: string; depth: number }> = [{ scene: currentSceneName, depth: 0 }];
  visited.add(currentSceneName);

  while (queue.length) {
    const { scene, depth } = queue.shift()!;
    if (!columns[depth]) columns[depth] = [];
    columns[depth].push(scene);
    const links = sceneLinkMap[scene] ?? [];
    for (const link of links) {
      const target = link.target;
      if (!target || visited.has(target)) continue;
      visited.add(target);
      queue.push({ scene: target, depth: depth + 1 });
    }
  }

  const orphanScenes = scenes.filter((s) => s !== currentSceneName && !visited.has(s));
  if (orphanScenes.length) {
    const orphanCol = columns.length;
    columns[orphanCol] = orphanScenes;
  }

  const layout: WorldNodeLayout[] = [];
  let maxRows = 0;
  columns.forEach((column, colIdx) => {
    if (!column) return;
    maxRows = Math.max(maxRows, column.length);
    column.forEach((scene, rowIdx) => {
      const outgoing = sceneLinkMap[scene] ?? [];
      const isCurrent = scene === currentSceneName;
      const outgoingValid = outgoing.filter((l) => l.target);
      let kind: WorldNodeLayout['kind'] = 'branch';
      if (isCurrent) kind = 'start';
      else if (outgoingValid.length >= 2) kind = 'choice';
      else if (outgoingValid.length === 0) kind = 'orphan';
      layout.push({
        scene,
        column: colIdx,
        row: rowIdx,
        x: PADDING + colIdx * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + rowIdx * (NODE_HEIGHT + ROW_GAP),
        kind,
        outgoing: outgoingValid,
        incoming: incomingCount[scene] ?? 0,
        isCurrent,
        isOrphan: !visited.has(scene) || kind === 'orphan',
      });
    });
  });

  const totalCols = columns.length;
  const width = PADDING * 2 + totalCols * NODE_WIDTH + Math.max(0, totalCols - 1) * COLUMN_GAP;
  const height = PADDING * 2 + Math.max(1, maxRows) * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  return { nodes: layout, width, height };
}

function buildEdgePath(from: WorldNodeLayout, to: WorldNodeLayout): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

interface FullScreenWorldlineProps {
  scenes: string[];
  currentSceneName: string;
  sceneHeaders: Record<string, SceneHeader>;
  sceneLinkMap: Record<string, SceneLink[]>;
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  onSelectNode: (node: WebGalNode) => void;
  onOpenScene: (sceneName: string) => void;
  onClose: () => void;
  characterColors?: Record<string, string>;
  nodePositions?: Record<string, { x: number; y: number }>;
  onUpdateNodePosition?: (sceneName: string, x: number, y: number) => void;
  onAddSceneLink?: (fromScene: string, toScene: string) => void;
  onRemoveSceneLink?: (fromScene: string, toScene: string, kind: SceneLink['kind']) => void;
  onNewScene?: () => void;
  onDeleteScene?: (sceneName: string) => void;
  onRenameScene?: (sceneName: string) => void;
  onOpenSceneManager?: () => void;
}

function FullScreenWorldline({
  scenes,
  currentSceneName,
  sceneHeaders,
  sceneLinkMap,
  nodes,
  selectedNode,
  onSelectNode,
  onOpenScene,
  onClose,
  characterColors,
  nodePositions,
  onUpdateNodePosition,
  onAddSceneLink,
  onRemoveSceneLink,
  onNewScene,
  onDeleteScene,
  onRenameScene,
  onOpenSceneManager,
}: FullScreenWorldlineProps) {
  const visibleNodes = nodes.filter((node) => node.type !== 'comment' || node.content?.trim());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [nodeDrag, setNodeDrag] = useState<{ sceneName: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ from: string; to: string; kind: string; label?: string; x: number; y: number } | null>(null);
  const [connDrag, setConnDrag] = useState<{ fromScene: string; sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ sceneName: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerRectRef = useRef<DOMRect | null>(null);

  const baseLayout = useMemo(
    () => buildWorldLayout(scenes, currentSceneName, sceneLinkMap),
    [scenes, currentSceneName, sceneLinkMap],
  );

  // Apply custom node positions
  const layout = useMemo(() => {
    const nodes = baseLayout.nodes.map((n) => {
      const custom = nodePositions?.[n.scene];
      if (custom) return { ...n, x: custom.x, y: custom.y };
      return n;
    });
    // Recalculate bounds
    let maxX = 0, maxY = 0;
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }
    return { nodes, width: Math.max(baseLayout.width, maxX + PADDING), height: Math.max(baseLayout.height, maxY + PADDING) };
  }, [baseLayout, nodePositions]);

  const { width, height } = layout;

  const layoutMap = useMemo(() => {
    const map = new Map<string, WorldNodeLayout>();
    for (const n of layout.nodes) map.set(n.scene, n);
    return map;
  }, [layout.nodes]);

  const edges = useMemo(() => {
    const result: Array<{ from: WorldNodeLayout; to: WorldNodeLayout; active: boolean; label?: string; kind: SceneLink['kind'] }> = [];
    for (const node of layout.nodes) {
      for (const link of node.outgoing) {
        const target = layoutMap.get(link.target);
        if (!target) continue;
        result.push({ from: node, to: target, active: node.isCurrent, label: link.label, kind: link.kind });
      }
    }
    return result;
  }, [layout.nodes, layoutMap]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((z) => Math.min(1.4, Math.max(0.5, +(z + delta).toFixed(2))));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // --- Node drag handling ---
  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, sceneName: string) => {
      if (e.button !== 0) return;
      if (connectMode) return;
      e.stopPropagation();
      const node = layout.nodes.find((n) => n.scene === sceneName);
      if (!node) return;
      setNodeDrag({ sceneName, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y });
    },
    [connectMode, layout.nodes],
  );

  const handleNodeMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!nodeDrag || !onUpdateNodePosition) return;
      const dx = (e.clientX - nodeDrag.startX) / zoom;
      const dy = (e.clientY - nodeDrag.startY) / zoom;
      const nx = Math.round(nodeDrag.origX + dx);
      const ny = Math.round(nodeDrag.origY + dy);
      onUpdateNodePosition(nodeDrag.sceneName, nx, ny);
    },
    [nodeDrag, zoom, onUpdateNodePosition],
  );

  const handleNodeMouseUp = useCallback(() => setNodeDrag(null), []);

  useEffect(() => {
    if (!nodeDrag) return;
    const stop = () => setNodeDrag(null);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [nodeDrag]);

  // --- Canvas pan handling ---
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-worldline-node]') || target.closest('[data-worldline-edge]')) return;
      setDragging({ startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y });
    },
    [pan],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (nodeDrag) { handleNodeMouseMove(e); return; }
      if (!dragging) return;
      setPan({ x: dragging.baseX + (e.clientX - dragging.startX), y: dragging.baseY + (e.clientY - dragging.startY) });
    },
    [dragging, nodeDrag, handleNodeMouseMove],
  );

  const onMouseUp = useCallback(() => { setDragging(null); handleNodeMouseUp(); }, [handleNodeMouseUp]);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(null);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [dragging]);

  // --- Connect mode node click ---
  const handleNodeClick = useCallback(
    (sceneName: string) => {
      if (!connectMode || !onAddSceneLink) {
        onOpenScene(sceneName);
        return;
      }
      if (!connectSource) {
        setConnectSource(sceneName);
      } else if (connectSource !== sceneName) {
        onAddSceneLink(connectSource, sceneName);
        setConnectSource(null);
        setConnectMode(false);
      }
    },
    [connectMode, connectSource, onAddSceneLink, onOpenScene],
  );

  // --- Drag-to-connect from node handle ---
  const getSceneAtPoint = useCallback(
    (clientX: number, clientY: number): string | null => {
      const rect = containerRectRef.current;
      if (!rect) return null;
      // Convert screen coords to layout coords
      const lx = (clientX - rect.left - pan.x) / zoom;
      const ly = (clientY - rect.top - pan.y) / zoom;
      for (const node of layout.nodes) {
        if (lx >= node.x && lx <= node.x + NODE_WIDTH && ly >= node.y && ly <= node.y + NODE_HEIGHT) {
          return node.scene;
        }
      }
      return null;
    },
    [layout.nodes, pan, zoom],
  );

  const handleConnDragStart = useCallback(
    (e: React.MouseEvent, fromScene: string) => {
      if (!onAddSceneLink) return;
      e.stopPropagation();
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) containerRectRef.current = rect;
      setConnDrag({ fromScene, sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY });
    },
    [onAddSceneLink],
  );

  useEffect(() => {
    if (!connDrag) return;
    const handleMove = (e: MouseEvent) => {
      setConnDrag((prev) => (prev ? { ...prev, ex: e.clientX, ey: e.clientY } : null));
    };
    const handleUp = (e: MouseEvent) => {
      setConnDrag((prev) => {
        if (prev && onAddSceneLink) {
          const target = getSceneAtPoint(e.clientX, e.clientY);
          if (target && target !== prev.fromScene) {
            onAddSceneLink(prev.fromScene, target);
          }
        }
        return null;
      });
      containerRectRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [connDrag, onAddSceneLink, getSceneAtPoint]);

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface-container-low px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-foreground transition-colors"
            aria-label="返回编辑器"
          >
            <ArrowRight className="h-4 w-4 rotate-180" />
            返回编辑器
          </button>
          <div className="h-5 w-px bg-border/60" />
          <span className="flex items-center gap-2 font-mono-family text-xs font-semibold uppercase tracking-widest text-on-surface-variant">
            <GitBranch className="h-4 w-4 text-secondary" /> 场景关系图 · 全屏
          </span>
          <span className="rounded bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
            {scenes.length} 场景
          </span>
          {onNewScene && (
            <button
              type="button"
              onClick={onNewScene}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-primary transition-colors"
              title="新建场景"
            >
              <Plus className="h-3.5 w-3.5" />
              新建
            </button>
          )}
          {onOpenSceneManager && (
            <button
              type="button"
              onClick={onOpenSceneManager}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-foreground transition-colors"
              title="场景管理"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              管理
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onAddSceneLink && (
            <>
              <button
                type="button"
                onClick={() => { setConnectMode(!connectMode); setConnectSource(null); }}
                className={`flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors ${
                  connectMode
                    ? 'bg-tertiary/20 text-tertiary ring-1 ring-tertiary/40'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-tertiary'
                }`}
                title={connectMode ? '退出连线模式' : '连线模式：点击节点或拖拽节点右侧圆点来创建场景跳转'}
              >
                <Plus className="h-3.5 w-3.5" />
                连线
              </button>
              <div className="h-4 w-px bg-border/60" />
            </>
          )}
          {connectMode && (
            <span className="rounded bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] text-tertiary">
              {connectSource ? `来源: ${connectSource} → 点击目标` : '点击来源场景'}
            </span>
          )}
          <button type="button" onClick={() => adjustZoom(-0.1)} className="story-os-icon-button h-7 w-7" aria-label="缩小" title="缩小">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[32px] text-center font-mono text-[10px] text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" onClick={() => adjustZoom(0.1)} className="story-os-icon-button h-7 w-7" aria-label="放大" title="放大">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={resetView} className="story-os-icon-button h-7 w-7" aria-label="重置视图" title="重置视图">
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Large canvas */}
        <div
          ref={containerRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          className={`relative flex-1 overflow-hidden bg-surface-container-low ${
            connectMode ? 'cursor-crosshair' : dragging || nodeDrag ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          <div className="absolute inset-0 opacity-60 flow-grid pointer-events-none" />
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              width,
              height,
            }}
          >
            <svg className="pointer-events-none absolute inset-0" style={{ width, height, overflow: 'visible' }}>
              {edges.map((edge, idx) => {
                const midX = (edge.from.x + NODE_WIDTH + edge.to.x) / 2;
                const midY = (edge.from.y + edge.to.y + NODE_HEIGHT) / 2;
                return (
                  <g key={`${edge.from.scene}-${edge.to.scene}-${idx}`}>
                    {/* Invisible wide hit area for edge hover/click */}
                    <path
                      d={buildEdgePath(edge.from, edge.to)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      className="pointer-events-auto cursor-pointer"
                      data-worldline-edge
                      onMouseEnter={(e) => {
                        const rect = containerRef.current?.getBoundingClientRect();
                        if (rect) {
                          setHoveredEdge({ from: edge.from.scene, to: edge.to.scene, kind: edge.kind, label: edge.label, x: e.clientX - rect.left, y: e.clientY - rect.top });
                        }
                      }}
                      onMouseLeave={() => setHoveredEdge(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onRemoveSceneLink) {
                          const ok = window.confirm(`删除从 "${edge.from.scene}" 到 "${edge.to.scene}" 的 ${edge.kind === 'choose' ? '分支' : '跳转'} 链接？\n这将修改源场景文件。`);
                          if (ok) onRemoveSceneLink(edge.from.scene, edge.to.scene, edge.kind);
                        }
                      }}
                    />
                    <path
                      d={buildEdgePath(edge.from, edge.to)}
                      fill="none"
                      stroke={edge.active ? 'var(--color-primary, #a43758)' : 'var(--color-outline-variant, #c8c2bf)'}
                      strokeWidth={edge.active ? 2.5 : 1.5}
                      strokeDasharray={edge.active ? undefined : '4 4'}
                      opacity={edge.active ? 1 : 0.6}
                      className="pointer-events-none"
                    />
                    {/* Edge kind badge */}
                    <circle
                      cx={midX}
                      cy={midY}
                      r={6}
                      fill="var(--color-surface-bright, #fff)"
                      stroke={edge.active ? 'var(--color-primary, #a43758)' : 'var(--color-outline-variant, #c8c2bf)'}
                      strokeWidth={1}
                      className="pointer-events-none"
                    />
                    <text
                      x={midX}
                      y={midY + 2.5}
                      textAnchor="middle"
                      className="pointer-events-none fill-on-surface-variant font-mono text-[7px] font-bold"
                    >
                      {edge.kind === 'choose' ? 'C' : edge.kind === 'call' ? '↗' : '→'}
                    </text>
                  </g>
                );
              })}
              {/* Edge labels */}
              {edges.map((edge, idx) => {
                if (!edge.label) return null;
                const mx = (edge.from.x + NODE_WIDTH + edge.to.x) / 2;
                const my = (edge.from.y + edge.to.y + NODE_HEIGHT) / 2;
                return (
                  <text
                    key={`label-${idx}`}
                    x={mx}
                    y={my - 12}
                    className="fill-on-surface-variant/50 font-mono text-[8px] pointer-events-none"
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                );
              })}
            </svg>

            {/* Temp connection line while dragging to connect */}
            {connDrag && onAddSceneLink && (() => {
              const srcNode = layout.nodes.find((n) => n.scene === connDrag.fromScene);
              if (!srcNode) return null;
              const sx = srcNode.x + NODE_WIDTH;
              const sy = srcNode.y + NODE_HEIGHT / 2;
              // Convert screen endpoint to layout coords
              const rect = containerRectRef.current;
              let ex = connDrag.ex, ey = connDrag.ey;
              if (rect) {
                ex = (connDrag.ex - rect.left - pan.x) / zoom;
                ey = (connDrag.ey - rect.top - pan.y) / zoom;
              }
              return (
                <svg className="pointer-events-none absolute inset-0" style={{ width, height, overflow: 'visible', zIndex: 10 }}>
                  <line x1={sx} y1={sy} x2={ex} y2={ey}
                    stroke="var(--color-tertiary, #5b7a4c)" strokeWidth={2} strokeDasharray="6 3" opacity={0.8} />
                  <circle cx={ex} cy={ey} r={4} fill="var(--color-tertiary, #5b7a4c)" opacity={0.8} />
                </svg>
              );
            })()}
            {layout.nodes.map((node) => {
              const isCurrent = node.isCurrent;
              const isChoice = node.kind === 'choice';
              const isConnectSource = connectMode && connectSource === node.scene;
              const isDragTarget = nodeDrag?.sceneName === node.scene;
              return (<>
                <button
                  key={node.scene}
                  type="button"
                  data-worldline-node
                  onMouseDown={(e) => handleNodeMouseDown(e, node.scene)}
                  onClick={() => handleNodeClick(node.scene)}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ sceneName: node.scene, x: e.clientX, y: e.clientY }); }}
                  style={{ left: node.x, top: node.y, position: 'absolute', width: NODE_WIDTH, height: NODE_HEIGHT, zIndex: isCurrent || isConnectSource ? 3 : 1 }}
                  className={`flex flex-col rounded border bg-surface-container-lowest px-2.5 py-1.5 text-left shadow-sm transition-all ${
                    isConnectSource
                      ? 'border-tertiary ring-2 ring-tertiary/50'
                      : isCurrent
                        ? 'border-primary ring-2 ring-primary/30'
                        : isChoice
                          ? 'border-primary/40 hover:border-primary'
                          : node.isOrphan
                            ? 'border-dashed border-outline-variant/40 opacity-70 hover:opacity-100'
                            : connectMode
                              ? 'border-outline-variant/40 hover:border-tertiary hover:ring-1 hover:ring-tertiary/30'
                              : 'border-outline-variant/40 hover:border-secondary'
                  } ${
                    isDragTarget ? 'opacity-80 shadow-lg' : ''
                  } ${
                    connectMode && !isConnectSource ? 'hover:scale-105' : ''
                  }`}
                  title={node.scene}
                >
                  <div className="flex items-center gap-1">
                    {isCurrent ? (
                      <BookOpen className="h-3 w-3 text-primary" />
                    ) : isChoice ? (
                      <Split className="h-3 w-3 text-primary" />
                    ) : (
                      <CornerDownRight className="h-3 w-3 text-on-surface-variant" />
                    )}
                    <span className="truncate font-mono-family text-[9px] uppercase tracking-widest text-on-surface-variant">
                      {isCurrent ? '当前' : isChoice ? `选择点 · ${node.outgoing.length}` : sceneHeaders[node.scene]?.chapter || '场景'}
                    </span>
                    {node.incoming > 0 && (
                      <span className="ml-auto rounded bg-secondary-container/30 px-1 font-mono text-[8px] text-secondary">
                        ←{node.incoming}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate font-display-family text-xs font-semibold text-foreground">
                    {sceneHeaders[node.scene]?.chapter?.replace(/[;：:]\s.*$/, '').trim() || node.scene.replace(/\.txt$/, '')}
                  </div>
                  <div className="truncate font-mono text-[9px] text-muted-foreground">
                    {node.scene}
                  </div>
                </button>
                {/* Connection handle on right edge — drag to another node to create a link */}
                {onAddSceneLink && (
                  <div
                    className="absolute"
                    style={{ left: node.x + NODE_WIDTH - 6, top: node.y + NODE_HEIGHT / 2 - 6, width: 12, height: 12, zIndex: 5 }}
                    onMouseDown={(e) => handleConnDragStart(e, node.scene)}
                    title={`从 ${node.scene} 拖拽到目标场景来创建连接`}
                  >
                    <div
                      className={`h-full w-full rounded-full border-2 border-outline-variant/50 bg-surface-bright shadow-sm transition-all hover:scale-150 hover:border-tertiary hover:bg-tertiary/30 cursor-crosshair ${
                        connectMode ? 'opacity-100' : 'opacity-0 hover:opacity-100'
                      }`}
                    />
                  </div>
                )}
              </>);
            })}
          </div>
          {layout.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              加载中…
            </div>
          )}

          {/* Edge hover tooltip */}
          {hoveredEdge && (
            <div
              className="pointer-events-none absolute z-40 rounded border border-border bg-surface-container-high px-2 py-1 shadow-md"
              style={{ left: hoveredEdge.x + 12, top: hoveredEdge.y - 12 }}
            >
              <div className="font-mono text-[9px] text-on-surface">
                {hoveredEdge.from} → {hoveredEdge.to}
              </div>
              <div className="mt-0.5 text-[8px] text-muted-foreground">
                {hoveredEdge.kind === 'choose' ? '分支选择' : hoveredEdge.kind === 'call' ? '场景调用' : '场景跳转'}
                {hoveredEdge.label ? ` · ${hoveredEdge.label}` : ''}
                {onRemoveSceneLink ? ' · 点击删除' : ''}
              </div>
            </div>
          )}

          {/* Right-click context menu on nodes */}
          {ctxMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
              <div
                className="fixed z-50 min-w-[160px] rounded border border-border bg-surface-container-high p-1 shadow-lg"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
              >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                onClick={() => { onOpenScene(ctxMenu.sceneName); setCtxMenu(null); }}
              >
                <BookOpen className="h-3.5 w-3.5" />
                切换到此场景
              </button>
              {onRenameScene && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs hover:bg-surface-container-low"
                  onClick={() => { onRenameScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <FileText className="h-3.5 w-3.5" />
                  重命名
                </button>
              )}
              {onDeleteScene && ctxMenu.sceneName !== currentSceneName && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-error hover:bg-error/10"
                  onClick={() => { onDeleteScene(ctxMenu.sceneName); setCtxMenu(null); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除场景
                </button>
              )}
              <div className="my-0.5 h-px bg-border/50" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-container-low"
                onClick={() => setCtxMenu(null)}
              >
                关闭
              </button>
            </div>
            </>
          )}
        </div>

        {/* Right sidebar: node index */}
        <div className="flex w-72 shrink-0 flex-col border-l border-border bg-surface-container-lowest">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">当前场景索引</span>
            <span className="font-mono-family text-[10px] text-muted-foreground">{visibleNodes.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleNodes.map((node, index) => {
              const Icon = commandIconFor(node.type);
              const sel = selectedNode?.id === node.id;
              const charColor = node.type === 'dialogue' && node.character && characterColors?.[node.character]
                ? characterColors[node.character]
                : undefined;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node)}
                  className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                    sel ? 'border-secondary bg-surface-container-low' : 'border-transparent hover:bg-surface-container-low'
                  }`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${commandToneFor(node.type)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono-family text-[10px] text-muted-foreground">{index + 1} {node.type}</span>
                    <span className="block truncate text-xs text-on-surface">{getCommandSummary(node)}</span>
                  </span>
                  {charColor && (
                    <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: charColor }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SceneWorldlinePanel({
  scenes,
  currentSceneName,
  sceneHeaders,
  sceneLinkMap,
  nodes,
  selectedNode,
  onSelectNode,
  onOpenScene,
  onOpenSceneManager,
  characterColors,
  nodePositions,
  onUpdateNodePosition,
  onAddSceneLink: _onAddSceneLink,
  onRemoveSceneLink: _onRemoveSceneLink,
}: SceneWorldlinePanelProps) {
  const visibleNodes = nodes.filter((node) => node.type !== 'comment' || node.content?.trim());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [sideNodeDrag, setSideNodeDrag] = useState<{ sceneName: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const baseLayout = useMemo(
    () => buildWorldLayout(scenes, currentSceneName, sceneLinkMap),
    [scenes, currentSceneName, sceneLinkMap],
  );

  const layout = useMemo(() => {
    const nodes = baseLayout.nodes.map((n) => {
      const custom = nodePositions?.[n.scene];
      if (custom) return { ...n, x: custom.x, y: custom.y };
      return n;
    });
    let maxX = 0, maxY = 0;
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }
    return { nodes, width: Math.max(baseLayout.width, maxX + PADDING), height: Math.max(baseLayout.height, maxY + PADDING) };
  }, [baseLayout, nodePositions]);

  const { width, height } = layout;

  const layoutMap = useMemo(() => {
    const map = new Map<string, WorldNodeLayout>();
    for (const n of layout.nodes) map.set(n.scene, n);
    return map;
  }, [layout.nodes]);

  const edges = useMemo(() => {
    const result: Array<{ from: WorldNodeLayout; to: WorldNodeLayout; active: boolean; label?: string; kind: SceneLink['kind'] }> = [];
    for (const node of layout.nodes) {
      for (const link of node.outgoing) {
        const target = layoutMap.get(link.target);
        if (!target) continue;
        result.push({
          from: node,
          to: target,
          active: node.isCurrent,
          label: link.label,
          kind: link.kind,
        });
      }
    }
    return result;
  }, [layout.nodes, layoutMap]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((z) => Math.min(1.4, Math.max(0.5, +(z + delta).toFixed(2))));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // --- Side panel node drag ---
  const handleSideNodeMouseDown = useCallback(
    (e: React.MouseEvent, sceneName: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const node = layout.nodes.find((n) => n.scene === sceneName);
      if (!node || !onUpdateNodePosition) return;
      setSideNodeDrag({ sceneName, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y });
    },
    [layout.nodes, onUpdateNodePosition],
  );

  const handleSideNodeMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!sideNodeDrag || !onUpdateNodePosition) return;
      const dx = (e.clientX - sideNodeDrag.startX) / zoom;
      const dy = (e.clientY - sideNodeDrag.startY) / zoom;
      onUpdateNodePosition(sideNodeDrag.sceneName, Math.round(sideNodeDrag.origX + dx), Math.round(sideNodeDrag.origY + dy));
    },
    [sideNodeDrag, zoom, onUpdateNodePosition],
  );

  useEffect(() => {
    if (!sideNodeDrag) return;
    const stop = () => setSideNodeDrag(null);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [sideNodeDrag]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-worldline-node]') || target.closest('[data-worldline-edge]')) return;
      setDragging({ startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y });
    },
    [pan],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (sideNodeDrag) { handleSideNodeMouseMove(e); return; }
      if (!dragging) return;
      setPan({ x: dragging.baseX + (e.clientX - dragging.startX), y: dragging.baseY + (e.clientY - dragging.startY) });
    },
    [dragging, sideNodeDrag, handleSideNodeMouseMove],
  );

  const onMouseUp = useCallback(() => { setDragging(null); setSideNodeDrag(null); }, []);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(null);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [dragging]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface-container-lowest">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="flex items-center gap-1.5 font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
          <GitBranch className="h-3 w-3 text-secondary" /> 场景关系图
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => adjustZoom(-0.1)}
            className="story-os-icon-button h-6 w-6"
            aria-label="缩小"
            title="缩小"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          <span className="min-w-[28px] text-center font-mono-family text-[9px] text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => adjustZoom(0.1)}
            className="story-os-icon-button h-6 w-6"
            aria-label="放大"
            title="放大"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="story-os-icon-button h-6 w-6"
            aria-label="重置视图"
            title="重置视图"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          {onOpenSceneManager && (
            <button
              type="button"
              onClick={onOpenSceneManager}
              className="story-os-icon-button h-6 w-6"
              aria-label="场景管理"
              title="场景管理"
            >
              <FolderOpen className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        className={`relative h-72 shrink-0 overflow-hidden border-b border-border bg-surface-container-low ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <div className="absolute inset-0 opacity-60 flow-grid pointer-events-none" />
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width,
            height,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            style={{ width, height, overflow: 'visible' }}
          >
            {edges.map((edge, idx) => (
              <path
                key={`${edge.from.scene}-${edge.to.scene}-${idx}`}
                d={buildEdgePath(edge.from, edge.to)}
                fill="none"
                stroke={edge.active ? 'var(--color-primary, #a43758)' : 'var(--color-outline-variant, #c8c2bf)'}
                strokeWidth={edge.active ? 2 : 1.5}
                strokeDasharray={edge.active ? undefined : '4 4'}
                opacity={edge.active ? 1 : 0.6}
              />
            ))}
          </svg>
          {layout.nodes.map((node) => {
            const isCurrent = node.isCurrent;
            const isChoice = node.kind === 'choice';
            return (
              <button
                key={node.scene}
                type="button"
                data-worldline-node
                onMouseDown={(e) => handleSideNodeMouseDown(e, node.scene)}
                onClick={() => onOpenScene(node.scene)}
                style={{ left: node.x, top: node.y, position: 'absolute', width: NODE_WIDTH, height: NODE_HEIGHT, zIndex: isCurrent ? 3 : 1 }}
                className={`flex flex-col rounded border bg-surface-container-lowest px-2.5 py-1.5 text-left shadow-sm transition-colors ${
                  isCurrent
                    ? 'border-primary ring-2 ring-primary/30'
                    : isChoice
                      ? 'border-primary/40 hover:border-primary'
                      : node.isOrphan
                        ? 'border-dashed border-outline-variant/40 opacity-70 hover:opacity-100'
                        : 'border-outline-variant/40 hover:border-secondary'
                }`}
                title={node.scene}
              >
                <div className="flex items-center gap-1">
                  {isCurrent ? (
                    <BookOpen className="h-3 w-3 text-primary" />
                  ) : isChoice ? (
                    <Split className="h-3 w-3 text-primary" />
                  ) : (
                    <CornerDownRight className="h-3 w-3 text-on-surface-variant" />
                  )}
                  <span className="truncate font-mono-family text-[9px] uppercase tracking-widest text-on-surface-variant">
                    {isCurrent ? '当前' : isChoice ? `选择点 · ${node.outgoing.length}` : sceneHeaders[node.scene]?.chapter || '场景'}
                  </span>
                  {node.incoming > 0 && (
                    <span className="ml-auto rounded bg-secondary-container/30 px-1 font-mono text-[8px] text-secondary">
                      ←{node.incoming}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate font-display-family text-xs font-semibold text-foreground">
                  {sceneHeaders[node.scene]?.chapter?.replace(/[;：:]\s.*$/, '').trim() || node.scene.replace(/\.txt$/, '')}
                </div>
                <div className="truncate font-mono text-[9px] text-muted-foreground">
                  {node.scene}
                </div>
              </button>
            );
          })}
        </div>
        {layout.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center text-[10px] text-muted-foreground">
            加载中…
          </div>
        )}
      </div>

      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">当前场景索引</span>
        <span className="font-mono-family text-[10px] text-muted-foreground">{visibleNodes.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleNodes.map((node, index) => {
          const Icon = commandIconFor(node.type);
          const selected = selectedNode?.id === node.id;
          const charColor = node.type === 'dialogue' && node.character && characterColors?.[node.character]
            ? characterColors[node.character]
            : undefined;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node)}
              className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                selected
                  ? 'border-secondary bg-surface-container-low'
                  : 'border-transparent hover:bg-surface-container-low'
              }`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${commandToneFor(node.type)}`} />
              <span className="min-w-0 flex-1">
                <span className="block font-mono-family text-[10px] text-muted-foreground">{index + 1} {node.type}</span>
                <span className="block truncate text-xs text-on-surface">{getCommandSummary(node)}</span>
              </span>
              {charColor && (
                <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: charColor }} />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function MiniLivePreview({ nodes }: { nodes: WebGalNode[] }) {
  const dialogue = nodes.find((node) => node.type === 'dialogue');
  const background = nodes.find((node) => node.type === 'changeBg');
  return (
    <div className="absolute right-6 top-14 z-20 flex h-36 w-64 flex-col overflow-hidden rounded-sm border border-border bg-surface-container-highest shadow-[0_0_0_3px_rgba(116,191,253,0.08)]">
      <div className="flex h-7 items-center justify-between border-b border-border bg-surface-container px-2">
        <span className="font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">实时预览</span>
        <ArrowRight className="h-3.5 w-3.5 -rotate-45 text-muted-foreground" />
      </div>
      <div className="story-os-blueprint relative flex flex-1 items-center justify-center overflow-hidden bg-inverse-surface">
        <div className="absolute inset-0 bg-secondary-fixed/15" />
        <Image className="h-10 w-10 text-secondary-container/60" />
        <div className="absolute bottom-2 left-2 right-2 border border-border bg-surface-container-lowest/90 p-2 backdrop-blur">
          <p className="mb-0.5 truncate text-[10px] font-bold text-primary">{dialogue?.character || background?.asset || '预览'}</p>
          <p className="truncate text-[11px] text-on-surface">"{dialogue?.content || '选择一个对白节点查看演出效果'}"</p>
        </div>
      </div>
    </div>
  );
}

interface AiAssistantPanelProps {
  aiAgent: ReturnType<typeof useAiAgent>;
  projectPath: string | null;
  onOpenSettings: () => void;
  onSend: () => void;
}

function AiAssistantPanel({ aiAgent, projectPath, onOpenSettings, onSend }: AiAssistantPanelProps) {
  const statusText = aiAgent.busy
    ? '生成中'
    : aiAgent.status === 'pending'
      ? '等待确认'
      : aiAgent.status === 'error'
        ? '需要处理'
        : '等待输入';

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-container-lowest">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary-container/35 text-secondary">
            <Wand2 className="h-3.5 w-3.5" />
          </div>
          <span className="truncate text-sm font-semibold text-on-surface">AI 创作助手</span>
          <span className="flex items-center gap-1 font-mono-family text-[10px] text-muted-foreground">
            <span className={`block h-1.5 w-1.5 rounded-full ${aiAgent.busy ? 'bg-primary' : 'bg-tertiary-container'}`} />
            {statusText}
          </span>
        </div>
        <button type="button" onClick={aiAgent.clearConversation} className="story-os-icon-button h-7 w-7" aria-label="清空 AI 对话">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {aiAgent.messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <AiMessageBubble
              role={message.role}
              content={message.content}
              isStreaming={aiAgent.streamingIdRef.current === message.id && aiAgent.busy}
              stopped={message.stopped}
              diff={message.diff}
            />
          </div>
        ))}
        {aiAgent.pendingChange?.status === 'pending' && (
          <AiPendingCard
            summary={aiAgent.pendingChange.summary}
            status={aiAgent.pendingChange.status}
            diff={aiAgent.pendingChange.diff}
            warnings={aiAgent.pendingChange.warnings}
            onAccept={aiAgent.acceptChange}
            onRevert={aiAgent.revertChange}
          />
        )}
        {aiAgent.status === 'missing_assets' && (
          <MissingAssetCard
            issues={aiAgent.missingIssues}
            onUseFallback={aiAgent.useFallbackAssets}
            onOpenAssets={aiAgent.openAssets}
            onRetryPrompt={aiAgent.retryWithExistingAssets}
          />
        )}
        {aiAgent.status === 'conflict' && (
          <ConflictCard
            onKeepManual={aiAgent.revertChange}
            onApplyAi={() => { void aiAgent.forceApplyChange(); }}
            onRegenerate={aiAgent.regenerateAfterConflict}
          />
        )}
        {aiAgent.error && aiAgent.status === 'error' && (
          <ErrorCard
            message={aiAgent.error.message}
            canRetry={aiAgent.error.retryable}
            cooldown={aiAgent.cooldown}
            showSettings={aiAgent.error.kind === 'auth'}
            onRetry={aiAgent.retry}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>

      <div className="border-t border-border bg-surface-container-low p-4">
        <AiMemoryPanel
          memory={aiAgent.memory}
          disabled={!projectPath}
          onSave={aiAgent.saveMemory}
        />
        <textarea
          value={aiAgent.input}
          onChange={(event) => aiAgent.setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          disabled={aiAgent.busy || aiAgent.pendingChange?.status === 'pending'}
          className="mt-3 h-20 w-full resize-none rounded-sm border border-border bg-surface-container-lowest p-2 text-sm focus:border-secondary focus:outline-none focus:ring-2 focus:ring-secondary-container/30 disabled:opacity-60"
          placeholder={aiAgent.busy ? '生成中...' : aiAgent.pendingChange?.status === 'pending' ? '请先接受或撤销当前 AI 修改...' : '输入你的创作想法...'}
          aria-label="AI 创作输入"
        />
        <button
          type="button"
          onClick={aiAgent.busy ? aiAgent.stop : onSend}
          disabled={!aiAgent.busy && (!aiAgent.input.trim() || aiAgent.pendingChange?.status === 'pending')}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-sm bg-secondary-container/60 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-secondary-container disabled:opacity-50"
        >
          {aiAgent.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {aiAgent.busy ? '停止' : '发送'}
        </button>
      </div>
    </aside>
  );
}

interface ScriptCommandStreamProps {
  nodes: WebGalNode[];
  selectedNode: WebGalNode | null;
  currentSceneName: string;
  sceneHeaders?: Record<string, SceneHeader>;
  onSelectNode: (node: WebGalNode) => void;
  onInsertNode: (type: WebGalCommandType, atIndex: number) => void;
  onDeleteNode?: (nodeId: string) => void;
  onCopyNode?: (nodeId: string) => void;
  onCutNode?: (nodeId: string) => void;
  onPasteNode?: (atIndex: number) => void;
  onReorderNodes?: (fromIndex: number, toIndex: number) => void;
  onJumpToIndex?: (index: number) => void;
  clipboardNode?: WebGalNode | null;
  characterColors?: Record<string, string>;
  searchQuery?: string;
}

function ScriptCommandStream({
  nodes,
  selectedNode,
  currentSceneName,
  sceneHeaders,
  onSelectNode,
  onInsertNode,
  onDeleteNode,
  onCopyNode,
  onCutNode,
  onPasteNode,
  onReorderNodes,
  onJumpToIndex,
  clipboardNode,
  characterColors,
  searchQuery,
}: ScriptCommandStreamProps) {
  const query = searchQuery?.trim().toLowerCase() ?? '';
  const visibleNodes = query
    ? nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => {
          const haystack = [node.type, node.character, node.content, node.asset, node.voice]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
    : nodes.map((node, index) => ({ node, index }));

  // --- Sub-components for DnD and insert zones ---

  const CMD_ITEM = 'script-command';

  function InsertZone({ atIndex, onInsert }: { atIndex: number; onInsert: (type: WebGalCommandType, atIndex: number) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <div
        className="group relative mx-auto flex h-2 max-w-3xl items-center justify-center hover:h-8"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-outline-variant/20 group-hover:bg-secondary/40 transition-colors" />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border border-outline-variant/30 bg-surface-bright text-[10px] text-muted-foreground opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:border-secondary hover:text-secondary"
          title="插入指令"
          aria-label="插入指令"
        >
          <Plus className="h-3 w-3" />
        </button>
        {open && (
          <div
            className="absolute left-1/2 top-full z-50 mt-1 w-72 -translate-x-1/2 rounded border border-border bg-surface-container-high p-3 shadow-lg"
            onMouseEnter={() => setOpen(true)}
          >
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">插入指令</div>
            {Object.entries(commandCategories).map(([category, types]) => (
              <div key={category} className="mb-2 last:mb-0">
                <div className="mb-1 text-[9px] font-semibold uppercase text-on-surface-variant/60">
                  {categoryLabels[category] || category}
                </div>
                <div className="flex flex-wrap gap-1">
                  {types.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => { onInsert(type, atIndex); setOpen(false); }}
                      className="rounded-sm border border-outline-variant/30 px-2 py-1 text-[10px] text-on-surface-variant hover:border-secondary hover:text-secondary transition-colors"
                    >
                      {commandLabels[type]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  interface ScriptCommandCardProps {
    node: WebGalNode;
    index: number;
    selected: boolean;
    Icon: ReturnType<typeof commandIconFor>;
    tag: string;
    tagClass: string;
    isDialogue: boolean;
    isBackground: boolean;
    isBranch: boolean;
    charColor?: string;
    onSelectNode: (node: WebGalNode) => void;
    onInsertNode: (type: WebGalCommandType, atIndex: number) => void;
    onDeleteNode?: (nodeId: string) => void;
    onCopyNode?: (nodeId: string) => void;
    onCutNode?: (nodeId: string) => void;
    onPasteNode?: (atIndex: number) => void;
    onReorderNodes?: (fromIndex: number, toIndex: number) => void;
    onJumpToIndex?: (index: number) => void;
    clipboardNode?: WebGalNode | null;
  }

  function ScriptCommandCard({
    node,
    index,
    selected,
    Icon,
    tag,
    tagClass,
    isDialogue,
    isBackground,
    isBranch,
    charColor,
    onSelectNode,
    onInsertNode,
    onDeleteNode,
    onCopyNode,
    onCutNode,
    onPasteNode,
    onReorderNodes,
    onJumpToIndex,
    clipboardNode,
  }: ScriptCommandCardProps) {
    const ref = useRef<HTMLDivElement>(null);

    const [{ isDragging }, drag, preview] = useDrag({
      type: CMD_ITEM,
      item: () => ({ index, id: node.id }),
      canDrag: () => Boolean(onReorderNodes) && !query,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    });

    const [, drop] = useDrop({
      accept: CMD_ITEM,
      hover: (item: { index: number; id: string }, monitor) => {
        if (!ref.current || !onReorderNodes) return;
        const dragIndex = item.index;
        const hoverIndex = index;
        if (dragIndex === hoverIndex) return;
        const hoverBoundingRect = ref.current.getBoundingClientRect();
        const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
        const clientOffset = monitor.getClientOffset();
        if (!clientOffset) return;
        const hoverClientY = clientOffset.y - hoverBoundingRect.top;
        if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return;
        if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return;
        onReorderNodes(dragIndex, hoverIndex);
        item.index = hoverIndex;
      },
    });

    drag(drop(ref));

    return (
      <div ref={preview} key={node.id} className="group flex gap-3" style={{ opacity: isDragging ? 0.4 : 1 }}>
        <div className="flex w-12 shrink-0 flex-col items-center pt-2">
          <div className={`flex h-8 w-8 items-center justify-center rounded-full border text-[10px] font-bold ${
            selected ? 'border-primary text-primary' : 'border-outline-variant/30 text-on-surface-variant/40'
          }`}>
            {String(index + 1).padStart(2, '0')}
          </div>
          <div className="my-2 w-px flex-1 bg-outline-variant/20" />
        </div>
        <div
          ref={ref}
          className={`relative w-full max-w-3xl overflow-hidden border shadow-sm transition-all ${
            isBranch
              ? `border-2 bg-tertiary/5 ${selected ? 'border-tertiary' : 'border-tertiary/30'} story-os-chamfer-tr`
              : `bg-surface-bright ${selected ? 'border-primary ring-1 ring-primary/20' : 'border-outline-variant/40 hover:border-secondary'}`
          }`}
        >
          <button
            type="button"
            onClick={() => onSelectNode(node)}
            className="w-full p-4 text-left"
          >
            <div className={`absolute right-0 top-0 px-2 py-1 text-[9px] uppercase tracking-tight ${tagClass}`}>{tag}</div>

            {isBackground ? (
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-24 shrink-0 items-center justify-center border border-outline-variant/20 bg-surface-container-highest">
                  <Image className="h-5 w-5 text-on-surface-variant/30" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-1 font-bold text-secondary">设置背景: {node.asset || node.content || '未选择背景'}</p>
                </div>
              </div>
            ) : isDialogue ? (
              <div className="flex items-start gap-3">
                {charColor ? (
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${charColor}20` }}
                  >
                    <span
                      className="h-5 w-5 rounded-full"
                      style={{ backgroundColor: charColor }}
                    />
                  </div>
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/20">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="font-bold"
                      style={charColor ? { color: charColor } : { color: 'var(--color-primary)' }}
                    >
                      {node.character || '未指定角色'}
                    </span>
                  </div>
                  <div className="border-l-4 border-primary/30 bg-surface-container-low/50 p-3 text-base leading-relaxed text-on-surface">
                    "{node.content || '……'}"
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {node.voice && <span className="rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface-variant/60">语音: {node.voice}</span>}
                    {node.figureEmotion && (
                      <span className="rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface-variant/60">表情: {node.figureEmotion}</span>
                    )}
                  </div>
                </div>
              </div>
            ) : isBranch ? (
              <>
                <div className="mb-4 flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-tertiary" />
                  <span className="font-bold text-tertiary">抉择分支: {node.content || '剧情选择'}</span>
                </div>
                <div className="space-y-2">
                  {(node.choices?.length ? node.choices : [{ text: getCommandSummary(node), target: '@next' }]).map((choice, choiceIndex) => (
                    <div key={`${node.id}-${choiceIndex}`} className="flex items-center justify-between border border-tertiary/20 bg-surface-bright p-2 text-sm">
                      <span>{choiceIndex + 1}. {choice.text}</span>
                      <span className="text-[10px] text-tertiary">跳转至: {choice.target}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 truncate text-sm">{getCommandSummary(node)}</span>
              </div>
            )}
          </button>
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              ref={onReorderNodes ? drag : undefined}
              onClick={(e) => e.stopPropagation()}
              className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-low hover:text-foreground cursor-grab active:cursor-grabbing"
              title="拖拽排序"
              aria-label="拖拽排序"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded p-1 text-outline-variant/60 hover:bg-surface-container-low hover:text-foreground"
                  title="更多操作"
                  aria-label="更多操作"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {onCopyNode && (
                  <DropdownMenuItem onClick={() => onCopyNode(node.id)}>
                    <Copy className="h-4 w-4" /> 复制
                  </DropdownMenuItem>
                )}
                {onCutNode && (
                  <DropdownMenuItem onClick={() => onCutNode(node.id)}>
                    <Scissors className="h-4 w-4" /> 剪切
                  </DropdownMenuItem>
                )}
                {onPasteNode && (
                  <DropdownMenuItem
                    onClick={() => onPasteNode(index)}
                    disabled={!clipboardNode}
                  >
                    <Clipboard className="h-4 w-4" /> 粘贴到此处
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onInsertNode(node.type, index + 1)}>
                  <Plus className="h-4 w-4" /> 在下方插入
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onInsertNode(node.type, index)}>
                  <ArrowRight className="h-4 w-4 -rotate-180" /> 在上方插入
                </DropdownMenuItem>
                {onJumpToIndex && (
                  <DropdownMenuItem onClick={() => onJumpToIndex(index)}>
                    <ArrowRight className="h-4 w-4" /> 跳到运行时
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {onDeleteNode && (
                  <DropdownMenuItem
                    onClick={() => onDeleteNode(node.id)}
                    className="text-error focus:text-error"
                  >
                    <Trash2 className="h-4 w-4" /> 删除
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-[#F7F9FC]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] story-os-dot-grid" />
      <MiniLivePreview nodes={nodes} />
      <div className="relative z-10 flex h-10 shrink-0 items-center justify-between border-b border-outline-variant/20 bg-surface-bright/50 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="shrink-0 text-xs font-bold tracking-widest text-on-surface-variant">指令流编辑</span>
          <div className="flex gap-2">
            {(() => {
              const header = sceneHeaders?.[currentSceneName];
              const chapter = header?.chapter?.trim() || '';
              if (chapter) {
                return (
                  <span className="rounded bg-secondary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-secondary">
                    {chapter}
                  </span>
                );
              }
              return null;
            })()}
            <span className="rounded bg-outline-variant/20 px-2 py-0.5 text-[10px] font-bold uppercase text-on-surface-variant">
              {currentSceneName.replace(/\.txt$/, '')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-on-surface-variant/50">
          {query && (
            <span className="rounded-full bg-primary-container/40 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {visibleNodes.length} / {nodes.length}
            </span>
          )}
          <span className="font-mono-family text-[10px] text-muted-foreground">
            {nodes.length} 条指令
          </span>
        </div>
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-4xl space-y-6 pb-20">
        {nodes.length === 0 ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 border border-dashed border-outline-variant/50 bg-surface-bright p-8 text-center text-muted-foreground">
            <FileText className="h-10 w-10 opacity-50" />
            <div className="text-base text-foreground">当前场景还没有命令</div>
            <button type="button" onClick={() => onInsertNode('dialogue', 0)} className="bg-primary px-4 py-2 text-sm font-semibold text-on-primary story-os-chamfer-tr">
              添加第一句对白
            </button>
          </div>
        ) : visibleNodes.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 border border-dashed border-outline-variant/40 bg-surface-bright p-6 text-center text-muted-foreground">
            <Search className="h-6 w-6 opacity-50" />
            <div className="text-sm">没有匹配 "{query}" 的指令</div>
          </div>
        ) : visibleNodes.map(({ node, index }) => {
          const Icon = commandIconFor(node.type);
          const selected = selectedNode?.id === node.id;
          const isDialogue = node.type === 'dialogue';
          const isBackground = node.type === 'changeBg';
          const isBranch = node.type === 'choose';
          const tag = isBackground ? 'BG_LOAD' : isDialogue ? 'TEXT_CMD' : isBranch ? 'BRANCH_LOGIC' : node.type.toUpperCase();
          const tagClass = isBackground
            ? 'bg-secondary text-on-secondary'
            : isBranch
            ? 'bg-tertiary text-on-tertiary'
            : 'bg-primary text-on-primary';
          const charColor = isDialogue && node.character && characterColors?.[node.character]
            ? characterColors[node.character]
            : undefined;

          return (
            <Fragment key={node.id}>
              {/* Insert zone before each node */}
              {onInsertNode && (
                <InsertZone atIndex={index} onInsert={onInsertNode} />
              )}
              <ScriptCommandCard
                node={node}
                index={index}
                selected={selected}
                Icon={Icon}
                tag={tag}
                tagClass={tagClass}
                isDialogue={isDialogue}
                isBackground={isBackground}
                isBranch={isBranch}
                charColor={charColor}
                onSelectNode={onSelectNode}
                onInsertNode={onInsertNode}
                onDeleteNode={onDeleteNode}
                onCopyNode={onCopyNode}
                onCutNode={onCutNode}
                onPasteNode={onPasteNode}
                onReorderNodes={onReorderNodes}
                onJumpToIndex={onJumpToIndex}
                clipboardNode={clipboardNode}
              />
            </Fragment>
          );
        })}
        {/* Insert zone at end */}
        {onInsertNode && nodes.length > 0 && (
          <InsertZone atIndex={nodes.length} onInsert={onInsertNode} />
        )}
        </div>

        {/* Right-click context menu on empty area for paste */}
        {clipboardNode && onPasteNode && (
          <div
            className="pointer-events-none absolute inset-0 z-20"
            onContextMenu={(e) => {
              e.preventDefault();
              const menu = document.createElement('div');
              menu.className = 'fixed z-50 min-w-[140px] rounded border border-border bg-surface-container-high p-1 shadow-lg';
              menu.style.left = `${e.clientX}px`;
              menu.style.top = `${e.clientY}px`;
              menu.innerHTML = '';
              const btn = document.createElement('button');
              btn.className = 'flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-container-low';
              btn.innerHTML = '<span style="display:flex;align-items:center;gap:0.5rem"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>粘贴到此处</span>';
              btn.onclick = () => {
                onPasteNode(nodes.length);
                menu.remove();
              };
              menu.appendChild(btn);
              document.body.appendChild(menu);
              const close = (ev: MouseEvent) => {
                if (!menu.contains(ev.target as Node)) {
                  menu.remove();
                  document.removeEventListener('click', close);
                }
              };
              setTimeout(() => document.addEventListener('click', close), 0);
            }}
          />
        )}

        <div className="sticky bottom-0 z-20 flex justify-center py-3 bg-gradient-to-t from-[#F7F9FC] via-[#F7F9FC]/80 to-transparent">
          <button type="button" onClick={() => onInsertNode('dialogue', nodes.length)} className="flex items-center gap-2 bg-primary px-6 py-2 font-semibold text-on-primary shadow-lg story-os-chamfer-tr">
            <Plus className="h-4 w-4" />
            新增指令流
          </button>
        </div>
      </div>
    </section>
  );
}

export function StoryEditor() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSceneName = searchParams.get('scene') || 'start.txt';
  const viewMode = searchParams.get('view'); // 'worldline' = full-screen scene graph

  // Project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [currentSceneName, setCurrentSceneName] = useState('start.txt');
  const [dirty, setDirty] = useState(false);
  const [sceneHeaders, setSceneHeaders] = useState<Record<string, SceneHeader>>({});
  const [sceneLinkMap, setSceneLinkMap] = useState<Record<string, SceneLink[]>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Editor state
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const nodesRef = useRef<WebGalNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<WebGalNode | null>(null);
  const [scriptSource, setScriptSource] = useState(DEMO_SCRIPT);
  const [showScript, setShowScript] = useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = useState('');
  const [clipboardNode, setClipboardNode] = useState<WebGalNode | null>(null);
  const [loading, setLoading] = useState(true);

  // AI state
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [projectMetadataOpen, setProjectMetadataOpen] = useState(false);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [exportTask, setExportTask] = useState<ExportTaskState>(IDLE_EXPORT_TASK);
  const lastExportPayloadRef = useRef<{
    metadata: ProjectMetadata;
    outputDir: string;
    asZip: boolean;
  } | null>(null);
  const [snapshotManagerOpen, setSnapshotManagerOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [sceneManagerOpen, setSceneManagerOpen] = useState(false);
  const [charactersForAi, setCharactersForAi] = useState<Character[]>([]);
  const [characterColors, setCharacterColors] = useState<Record<string, string>>({});
  const [worldNodePositions, setWorldNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [aiCollapsed, setAiCollapsed] = useState(() => localStorage.getItem(`story-ai-collapsed-${projectId}`) === '1');

  // Build character context for AI system prompt
  const buildCharacterContext = useCallback((chars: Character[]): string => {
    if (chars.length === 0) return '';
    return chars.map(c => {
      const parts: string[] = [];
      parts.push(`- ${c.name}`);
      if (c.aliases.length > 0) parts.push(`  别名: ${c.aliases.join(', ')}`);
      if (c.gender) parts.push(`  性别: ${c.gender}`);
      if (c.age) parts.push(`  年龄: ${c.age}`);
      if (c.personality) parts.push(`  性格: ${c.personality}`);
      if (c.stance) parts.push(`  立场: ${c.stance}`);
      if (c.keywords.length > 0) parts.push(`  关键词: ${c.keywords.join(', ')}`);
      if (c.description) parts.push(`  简介: ${c.description}`);
      if (c.dialogueStyle) parts.push(`  对话风格: ${c.dialogueStyle}`);
      if (c.relations.length > 0) {
        const rels = c.relations.map(r => `${r.relationType}->${r.targetId}`).join(', ');
        if (rels) parts.push(`  关系: ${rels}`);
      }
      return parts.join('\n');
    }).join('\n\n');
  }, []);

  const loadSceneHeaders = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const text = await readFileText(path);
          return [name, parseSceneHeader(text)] as const;
        } catch {
          return [name, {}] as const;
        }
      }),
    );
    setSceneHeaders(Object.fromEntries(entries));
  }, []);

  const loadSceneLinkMap = useCallback(async (projectPath: string, scenes: string[]) => {
    const entries = await Promise.all(
      scenes.map(async (name) => {
        try {
          const path = await getScenePath(projectPath, name);
          const nodes = await loadScene(path);
          return [name, extractSceneLinks(nodes)] as const;
        } catch {
          return [name, [] as SceneLink[]] as const;
        }
      }),
    );
    setSceneLinkMap(Object.fromEntries(entries));
  }, []);

  const loadCharacterColors = useCallback(async (projectPath: string) => {
    try {
      const refs = await listCharacterNames(projectPath);
      const map: Record<string, string> = {};
      refs.forEach((ref, idx) => {
        map[ref.name] = characterColor(idx);
      });
      setCharacterColors(map);
    } catch {
      setCharacterColors({});
    }
  }, []);

  const handleHeaderUpdated = useCallback((name: string, header: SceneHeader) => {
    setSceneHeaders((prev) => ({ ...prev, [name]: header }));
  }, []);

  const refreshProjectInfo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      void loadSceneLinkMap(projectPath, info.scenes);
    } catch {}
  }, [projectPath, loadSceneHeaders, loadSceneLinkMap]);

  const updateWorldNodePosition = useCallback((sceneName: string, x: number, y: number) => {
    setWorldNodePositions((prev) => ({ ...prev, [sceneName]: { x, y } }));
  }, []);

  const addSceneLink = useCallback(async (fromScene: string, toScene: string) => {
    if (!projectPath) return;
    try {
      const path = await getScenePath(projectPath, fromScene);
      const existingNodes = await loadScene(path);
      const id = Date.now().toString();
      const inserted: WebGalNode = {
        id,
        type: 'changeScene',
        content: toScene,
        targetScene: toScene,
        flags: [],
        position: { x: 100, y: 60 + existingNodes.length * 110 },
        connections: [],
      };
      const updated = [...existingNodes, inserted];
      await saveScene(path, updated);
      // If modifying the current scene, keep editor in sync
      if (fromScene === currentSceneName) {
        setNodes(updated);
        setScriptSource(await serializeScene(updated));
        setDirty(true);
        setSaveStatus('idle');
      }
      void loadSceneLinkMap(projectPath, projectInfo?.scenes ?? [fromScene]);
    } catch (e) {
      console.error('Failed to add scene link:', e);
    }
  }, [projectPath, currentSceneName, loadSceneLinkMap, projectInfo]);

  const removeSceneLink = useCallback(async (fromScene: string, toScene: string, kind: SceneLink['kind']) => {
    if (!projectPath) return;
    try {
      const path = await getScenePath(projectPath, fromScene);
      const existingNodes = await loadScene(path);
      const filtered = existingNodes.filter((n) => {
        if (kind === 'change' && n.type === 'changeScene') return n.targetScene !== toScene;
        if (kind === 'call' && n.type === 'callScene') return n.targetScene !== toScene;
        if (kind === 'choose' && n.type === 'choose' && n.choices) {
          // Keep the node but filter out the specific choice
          return n.choices.every((c) => c.target !== toScene);
        }
        return true;
      });
      // For choose nodes, also clean up choices that target the removed scene
      const cleaned = filtered.map((n) => {
        if (n.type === 'choose' && n.choices) {
          const kept = n.choices.filter((c) => c.target !== toScene);
          if (kept.length === n.choices.length) return n;
          return { ...n, choices: kept.length > 0 ? kept : [{ text: '选项 1', target: '' }] };
        }
        return n;
      });
      await saveScene(path, cleaned);
      if (fromScene === currentSceneName) {
        setNodes(cleaned);
        setScriptSource(await serializeScene(cleaned));
        setDirty(true);
        setSaveStatus('idle');
      }
      void loadSceneLinkMap(projectPath, projectInfo?.scenes ?? [fromScene]);
    } catch (e) {
      console.error('Failed to remove scene link:', e);
    }
  }, [projectPath, currentSceneName, loadSceneLinkMap, projectInfo]);

  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // In-memory draft cache: sceneName -> nodes snapshot for unsaved scenes
  const sceneDraftCache = useRef<Map<string, WebGalNode[]>>(new Map());
  const aiPendingPreviewRef = useRef(false);
  // Keep a ref in sync so the close-requested handler always sees current dirty state
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoSaveRef = useRef<ReturnType<typeof setInterval>>();

  // Auto-save wiring
  const [autoSaveInterval, setAutoSaveInterval] = useState(30);

  useEffect(() => {
    const settings = loadAppSettings();
    setAutoSaveInterval(settings.autoSaveInterval);
    if (settings.runtimeTemplateDir) {
      setRuntimeTemplateDir(settings.runtimeTemplateDir).catch((e) => {
        console.warn('[runtime] failed to set template dir from app settings:', e);
      });
    }
  }, []);

  useEffect(() => {
    getRuntimeUrl()
      .then((url) => console.info(`[runtime] preview URL: ${url}`))
      .catch((e) => console.warn('[runtime] URL unavailable:', e));
    (window as unknown as { __jumpTo?: typeof jumpToSentence }).__jumpTo = jumpToSentence;
  }, []);

  useEffect(() => {
    setRuntimeProject(projectPath).catch((e) =>
      console.warn('[runtime] failed to sync project path:', e),
    );
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setProjectMetadata(null);
      return;
    }
    readProjectMetadata(projectPath)
      .then((metadata) => setProjectMetadata(metadata ?? EMPTY_PROJECT_METADATA))
      .catch((e) => {
        console.warn('[project] failed to load metadata:', e);
        setProjectMetadata(EMPTY_PROJECT_METADATA);
      });
  }, [projectPath]);

  useEffect(() => {
    localStorage.setItem(`story-ai-collapsed-${projectId}`, aiCollapsed ? '1' : '0');
  }, [aiCollapsed, projectId]);

  // ---------------------------------------------------------------------------
  // Initialization: try to load project from localStorage or URL params
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      // Try to restore project path from localStorage
      const storedPath = localStorage.getItem(`project-path-${projectId}`);
      const sceneName = requestedSceneName;
      setCurrentSceneName(sceneName);

      if (storedPath) {
        try {
          const info = await openProject(storedPath);
          setProjectPath(storedPath);
          setProjectInfo(info);

          // Load the scene file
          const scenePath = await getScenePath(storedPath, sceneName);
          try {
            const loaded = await loadScene(scenePath);
            // Restore sessionStorage draft left by assets-page navigation
            const draftKey = `scene-draft-${projectId}-${sceneName}`;
            const draftJson = sessionStorage.getItem(draftKey);
            if (draftJson) {
              try {
                const draft = JSON.parse(draftJson) as WebGalNode[];
                setNodes(draft);
                const text = await serializeScene(draft);
                setScriptSource(text);
                setDirty(true);
              } catch {
                setNodes(loaded);
                const text = await serializeScene(loaded);
                setScriptSource(text);
              }
              sessionStorage.removeItem(draftKey);
            } else {
              setNodes(loaded);
              const text = await serializeScene(loaded);
              setScriptSource(text);
            }
          } catch {
            // Scene doesn't exist yet, start with empty
            const parsed = await parseScene(DEMO_SCRIPT);
            setNodes(parsed);
            setScriptSource(DEMO_SCRIPT);
          }
        } catch {
          // Stored path no longer valid, fall back to demo.
          const parsed = await parseScene(DEMO_SCRIPT);
          setNodes(parsed);
        }

        // Load character names for autocomplete
        try {
          const chars = await listCharacters(storedPath);
          setCharactersForAi(chars);
        } catch {
          setCharactersForAi([]);
        }
        void loadCharacterColors(storedPath);

        // Load scene header comments + outgoing scene-jump map for the graph view
        const info = await openProject(storedPath).catch(() => null);
        if (info) {
          void loadSceneHeaders(storedPath, info.scenes);
          void loadSceneLinkMap(storedPath, info.scenes);
        }
      } else {
        // No project path, just load demo script.
        const parsed = await parseScene(DEMO_SCRIPT);
        setNodes(parsed);
      }

      setLoading(false);
    };
    init();
  }, [projectId, requestedSceneName]);

  // ---------------------------------------------------------------------------
  // 同步节点到脚本文本
  // ---------------------------------------------------------------------------
  const syncScript = useCallback(async (nextNodes: WebGalNode[]) => {
    try {
      const text = await serializeScene(nextNodes);
      setScriptSource(text);
    } catch {
      // keep stale
    }
  }, []);

  // Mark dirty on any node change
  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveStatus('idle');
  }, []);

  const commitEditedNodes = useCallback((nextNodes: WebGalNode[]) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    void syncScript(nextNodes);
    markDirty();
  }, [markDirty, syncScript]);

  // Undo / Redo
  const [history, setHistory] = useState<WebGalNode[][]>([]);
  const [redoHistory, setRedoHistory] = useState<WebGalNode[][]>([]);

  const pushHistory = useCallback((nodesSnapshot: WebGalNode[]) => {
    setHistory(prev => {
      const next = [...prev, nodesSnapshot];
      return next.length > 50 ? next.slice(-50) : next;
    });
    setRedoHistory([]);
  }, []);

  // Debounce timer for merging successive updateNode calls to the same node
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingRecordRef = useRef<WebGalNode[] | null>(null);

  const flushPendingHistory = useCallback((): WebGalNode[] | null => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const pending = pendingRecordRef.current;
    if (!pending) return null;
    pushHistory(pending);
    pendingRecordRef.current = null;
    return pending;
  }, [pushHistory]);

  const undo = useCallback(() => {
    const current = nodesRef.current;
    const pending = flushPendingHistory();
    if (pending) {
      setHistory(prev => prev.slice(0, -1));
      setRedoHistory(prev => [...prev, current].slice(-50));
      commitEditedNodes(pending);
      setSelectedNode(null);
      return;
    }
    const prevNodes = history[history.length - 1];
    if (!prevNodes) return;
    setHistory(prev => prev.slice(0, -1));
    setRedoHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(prevNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, history]);

  const redo = useCallback(() => {
    if (flushPendingHistory()) return;
    const nextNodes = redoHistory[redoHistory.length - 1];
    if (!nextNodes) return;
    const current = nodesRef.current;
    setRedoHistory(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, current].slice(-50));
    commitEditedNodes(nextNodes);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, redoHistory]);

  // ---------------------------------------------------------------------------
  // Node CRUD
  // ---------------------------------------------------------------------------
  const insertNode = useCallback((type: WebGalCommandType, atIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const { nodes: updated, inserted } = insertSceneNode(current, type, atIndex, Date.now().toString());
    commitEditedNodes(updated);
    setSelectedNode(inserted);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const updateSelectedNode = useCallback((updates: Partial<WebGalNode>) => {
    const current = nodesRef.current;
    const selected = selectedNode;
    if (!selected) return;

    if (!pendingRecordRef.current) {
      pendingRecordRef.current = current;
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const pending = pendingRecordRef.current;
      if (pending) pushHistory(pending);
      pendingRecordRef.current = null;
    }, 800);

    let nextSelected: WebGalNode | null = null;
    const updated = current.map((node) => {
      if (node.id !== selected.id) return node;
      nextSelected = { ...node, ...updates };
      return nextSelected;
    });
    if (!nextSelected) return;
    nodesRef.current = updated;
    setNodes(updated);
    setSelectedNode(nextSelected);
    void syncScript(updated);
    markDirty();
  }, [markDirty, pushHistory, selectedNode, syncScript]);

  const deleteSelectedNode = useCallback(() => {
    const selected = selectedNode;
    if (!selected) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== selected.id);
    commitEditedNodes(updated);
    setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  // ---------------------------------------------------------------------------
  // Per-node operations (for context menu / drag handle)
  // ---------------------------------------------------------------------------
  const deleteNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = current.filter((node) => node.id !== nodeId);
    commitEditedNodes(updated);
    if (selectedNode?.id === nodeId) setSelectedNode(null);
  }, [commitEditedNodes, flushPendingHistory, pushHistory, selectedNode]);

  const copyNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__copy__${Date.now().toString()}` });
  }, []);

  const cutNode = useCallback((nodeId: string) => {
    const current = nodesRef.current;
    const target = current.find((node) => node.id === nodeId);
    if (!target) return;
    setClipboardNode({ ...target, id: `${target.id}__cut__${Date.now().toString()}` });
    deleteNode(nodeId);
  }, [deleteNode]);

  const reorderNodes = useCallback((fromIndex: number, toIndex: number) => {
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = reorderSceneNodes(current, fromIndex, toIndex);
    commitEditedNodes(updated);
  }, [commitEditedNodes, flushPendingHistory, pushHistory]);

  const pasteNode = useCallback((atIndex: number) => {
    if (!clipboardNode) return;
    const current = nodesRef.current;
    flushPendingHistory();
    pushHistory(current);
    const updated = pasteSceneNode(current, clipboardNode, atIndex, Date.now().toString());
    commitEditedNodes(updated);
  }, [clipboardNode, commitEditedNodes, flushPendingHistory, pushHistory]);

  const jumpToNode = useCallback((index: number) => {
    if (!currentSceneName) return;
    void jumpToSentence(currentSceneName, index + 1).catch((e) =>
      console.warn('[runtime] jumpToSentence failed:', e),
    );
  }, [currentSceneName]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaveStatus('saving');
    try {
      if (projectPath) {
        // Save to project's game/scene/ directory
        const scenePath = await getScenePath(projectPath, currentSceneName);
        await saveScene(scenePath, nodes);
      } else {
        // No project open, prompt user to pick a save location.
        const selected = await saveDialog({
          title: '保存场景文件',
          defaultPath: currentSceneName,
          filters: [{ name: 'WebGAL Scene', extensions: ['txt'] }],
        });
        if (!selected) {
          setSaveStatus('idle');
          return false;
        }
        await saveScene(selected, nodes);
      }
      setDirty(false);
      sceneDraftCache.current.delete(currentSceneName);
      // Refresh header + scene-graph link entry for the saved scene
      if (projectPath) void loadSceneHeaders(projectPath, projectInfo?.scenes ?? [currentSceneName]);
      setSceneLinkMap((prev) => ({ ...prev, [currentSceneName]: extractSceneLinks(nodes) }));
      setSaveStatus('saved');
      // Reset status after 2s
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      return true;
    } catch (e) {
      console.error('Save failed:', e);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      return false;
    }
  }, [projectPath, currentSceneName, nodes]);

  // Guard navigation that would discard unsaved changes (back to home, window close)
  const guardedNavigate = useCallback((action: () => void) => {
    if (dirty) {
      pendingActionRef.current = action;
      setUnsavedConfirmOpen(true);
    } else {
      action();
    }
  }, [dirty]);

  const handleUnsavedSaveAndLeave = useCallback(async () => {
    const action = pendingActionRef.current;
    if (await handleSave()) {
      pendingActionRef.current = null;
      setUnsavedConfirmOpen(false);
      action?.();
    }
  }, [handleSave]);

  const handleUnsavedDiscard = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setDirty(false);
    setUnsavedConfirmOpen(false);
    action?.();
  }, []);

  const handleUnsavedCancel = useCallback(() => {
    setUnsavedConfirmOpen(false);
    pendingActionRef.current = null;
  }, []);

  // Warn on window/tab close when dirty (web fallback)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Intercept Tauri native window close when dirty
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let appWindow: ReturnType<typeof getCurrentWindow>;
    try {
      appWindow = getCurrentWindow();
    } catch {
      return undefined;
    }
    appWindow.onCloseRequested((event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        pendingActionRef.current = () => void appWindow.destroy();
        setUnsavedConfirmOpen(true);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+S / Cmd+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Undo/Redo shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // Clipboard shortcuts (Ctrl+C/X/V)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'c' && selectedNode) {
          e.preventDefault();
          copyNode(selectedNode.id);
        } else if (e.key === 'x' && selectedNode) {
          e.preventDefault();
          cutNode(selectedNode.id);
        } else if (e.key === 'v' && clipboardNode) {
          e.preventDefault();
          const currentIndex = nodes.findIndex((n) => n.id === selectedNode?.id);
          pasteNode(currentIndex >= 0 ? currentIndex : nodes.length);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNode, clipboardNode, nodes, copyNode, cutNode, pasteNode]);

  // Auto-save: periodic save when dirty
  useEffect(() => {
    if (autoSaveInterval <= 0 || !projectPath) return;
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    autoSaveRef.current = setInterval(() => {
      if (dirty) {
        handleSave();
      }
    }, autoSaveInterval * 1000);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [autoSaveInterval, dirty, handleSave, projectPath]);

  // ---------------------------------------------------------------------------
  // Open project folder
  // ---------------------------------------------------------------------------
  const handleOpenProject = useCallback(async () => {
    const selected = await openDialog({
      title: '选择 WebGAL 项目文件夹',
      directory: true,
    });
    if (!selected) return;

    try {
      const info = await openProject(selected);
      setProjectPath(selected);
      setProjectInfo(info);
      localStorage.setItem(`project-path-${projectId}`, selected);

      // Load start.txt or first available scene
      const sceneName = info.scenes.includes('start.txt')
        ? 'start.txt'
        : info.scenes[0] || 'start.txt';
      setCurrentSceneName(sceneName);

      const scenePath = await getScenePath(selected, sceneName);
      try {
        const loaded = await loadScene(scenePath);
        setNodes(loaded);
        const text = await serializeScene(loaded);
        setScriptSource(text);
        setDirty(false);
      } catch {
        // empty scene
        setNodes([]);
        setScriptSource('');
      }

      // Load character names for autocomplete
      try {
        const chars = await listCharacters(selected);
        setCharactersForAi(chars);
      } catch {
        setCharactersForAi([]);
      }
      void loadCharacterColors(selected);

      void loadSceneHeaders(selected, info.scenes);
      void loadSceneLinkMap(selected, info.scenes);
    } catch (e) {
      console.error('Open project failed:', e);
    }
  }, [projectId, loadSceneHeaders, loadSceneLinkMap]);

  // ---------------------------------------------------------------------------
  // Switch scene within project
  // ---------------------------------------------------------------------------
  const handleSwitchScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;

    // Stash current unsaved nodes in the in-memory draft cache
    if (dirty && !aiPendingPreviewRef.current) {
      sceneDraftCache.current.set(currentSceneName, nodes);
    } else if (aiPendingPreviewRef.current) {
      sceneDraftCache.current.delete(currentSceneName);
    }

    setCurrentSceneName(sceneName);
    const scenePath = await getScenePath(projectPath, sceneName);
    try {
      // Prefer a cached draft over the saved file
      const draft = sceneDraftCache.current.get(sceneName);
      if (draft) {
        setNodes(draft);
        const text = await serializeScene(draft);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(true);
      } else {
        const loaded = await loadScene(scenePath);
        setNodes(loaded);
        const text = await serializeScene(loaded);
        setScriptSource(text);
        setSelectedNode(null);
        setDirty(false);
      }
    } catch {
      setNodes([]);
      setScriptSource('');
    }
  }, [projectPath, currentSceneName, dirty, nodes]);

  // Stable wrapper for child components (SceneGraph) so they can be memoized —
  // the underlying handleSwitchScene closes over `nodes`/`dirty` and changes
  // on every edit, but the click target only needs the latest implementation.
  const handleSwitchSceneRef = useRef(handleSwitchScene);
  handleSwitchSceneRef.current = handleSwitchScene;
  const stableSwitchScene = useCallback((name: string) => {
    void handleSwitchSceneRef.current(name);
  }, []);

  // ---------------------------------------------------------------------------
  // Create new scene
  // ---------------------------------------------------------------------------
  const handleNewScene = useCallback(async () => {
    if (!projectPath) return;
    const name = prompt('新场景文件名（不含 .txt）:');
    if (!name) return;
    try {
      await createScene(projectPath, name);
      // Refresh project info
      const info = await openProject(projectPath);
      setProjectInfo(info);
      // Switch to new scene
      const sceneName = name.endsWith('.txt') ? name : `${name}.txt`;
      await handleSwitchScene(sceneName);
    } catch (e) {
      console.error('Create scene failed:', e);
    }
  }, [projectPath, handleSwitchScene]);

  const handleDeleteScene = useCallback(async (sceneName: string) => {
    if (!projectPath) return;
    const ok = window.confirm(`确定删除场景 "${sceneName}" 吗？此操作不可恢复。`);
    if (!ok) return;
    try {
      const path = await getScenePath(projectPath, sceneName);
      await deleteScene(path);
      // If deleting the current scene, switch to another
      if (sceneName === currentSceneName) {
        const info = await openProject(projectPath);
        const remaining = info.scenes.filter((s) => s !== sceneName);
        if (remaining.length > 0) {
          await handleSwitchScene(remaining[0]);
        }
      }
      void refreshProjectInfo();
    } catch (e) {
      console.error('Delete scene failed:', e);
      alert(`删除场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, handleSwitchScene, refreshProjectInfo]);

  const handleRenameScene = useCallback(async (oldName: string) => {
    if (!projectPath) return;
    const newName = prompt(`重命名 "${oldName}" 为:`, oldName.replace(/\.txt$/, ''));
    if (!newName || newName === oldName) return;
    const finalName = newName.endsWith('.txt') ? newName : `${newName}.txt`;
    try {
      const path = await getScenePath(projectPath, oldName);
      await renameScene(path, finalName);
      void refreshProjectInfo();
      if (oldName === currentSceneName) {
        setCurrentSceneName(finalName);
      }
    } catch (e) {
      console.error('Rename scene failed:', e);
      alert(`重命名场景失败: ${e}`);
    }
  }, [projectPath, currentSceneName, refreshProjectInfo]);

  // ---------------------------------------------------------------------------
  // Import / Export / Apply script
  // ---------------------------------------------------------------------------
  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      setScriptSource(text);
      const parsed = await parseScene(text);
      setNodes(parsed);
      setSelectedNode(null);
      markDirty();
    };
    input.click();
  }, [markDirty]);

  const handleExport = useCallback(async () => {
    const text = await serializeScene(nodes);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentSceneName;
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, currentSceneName]);

  const handleApplyScript = useCallback(async () => {
    const parsed = await parseScene(scriptSource);
    setNodes(parsed);
    setSelectedNode(null);
    setShowScript(false);
    markDirty();
  }, [scriptSource, markDirty]);

  const projectName = projectInfo?.config.Game_name || projectPath?.split('/').pop() || '未命名项目';

  const handleSaveProjectMetadata = useCallback(async (metadata: ProjectMetadata) => {
    if (!projectPath) return;
    setMetadataSaving(true);
    try {
      await saveProjectMetadata(projectPath, metadata);
      setProjectMetadata(metadata);
    } catch (e) {
      alert(`保存元信息失败: ${e}`);
    } finally {
      setMetadataSaving(false);
    }
  }, [projectPath]);

  const handleExportProjectWithMetadata = useCallback(async (
    metadata: ProjectMetadata,
    outputDir: string,
    asZip: boolean,
  ) => {
    if (!projectPath) return;
    const failureCount = exportTask.status === 'failed' ? exportTask.failureCount : 0;
    lastExportPayloadRef.current = { metadata, outputDir, asZip };
    try {
      if (dirty && !(await handleSave())) return;
      const payload = { ...metadata, lastExportDir: outputDir };
      lastExportPayloadRef.current = { metadata: payload, outputDir, asZip };
      setExportTask({
        status: 'savingMetadata',
        warnings: [],
        issues: [],
        failureCount,
      });
      await saveProjectMetadata(projectPath, payload);
      setProjectMetadata(payload);
      setExportTask({
        status: 'exporting',
        warnings: [],
        issues: [],
        failureCount,
      });
      const result = await exportProject(projectPath, outputDir, asZip, payload);
      if (result.success) {
        setExportTask({
          status: 'succeeded',
          outputPath: result.outputPath || outputDir,
          warnings: result.warnings ?? [],
          issues: result.issues ?? [],
          failureCount: 0,
        });
      } else {
        setExportTask({
          status: 'failed',
          warnings: result.warnings ?? [],
          issues: result.issues ?? [],
          error: '导出校验未通过，请处理错误后重试。',
          failureCount: failureCount + 1,
        });
      }
    } catch (e) {
      setExportTask((prev) => ({
        status: 'failed',
        warnings: prev.warnings ?? [],
        issues: prev.issues ?? [],
        error: String(e),
        failureCount: failureCount + 1,
      }));
    }
  }, [projectPath, dirty, handleSave, exportTask.status, exportTask.failureCount]);

  const handleRetryExportProject = useCallback(async () => {
    const payload = lastExportPayloadRef.current;
    if (!payload) return;
    await handleExportProjectWithMetadata(payload.metadata, payload.outputDir, payload.asZip);
  }, [handleExportProjectWithMetadata]);

  const handleExportProject = useCallback(() => {
    if (!projectPath) return;
    setExportTask(IDLE_EXPORT_TASK);
    setProjectMetadataOpen(true);
  }, [projectPath]);

  const refreshSnapshots = useCallback(async () => {
    if (!projectPath) return;
    try {
      setSnapshotError(null);
      setSnapshots(await listProjectSnapshots(projectPath));
    } catch (e) {
      setSnapshotError(`读取快照失败: ${e}`);
    }
  }, [projectPath]);

  const handleOpenSnapshotManager = useCallback(() => {
    if (!projectPath) return;
    setSnapshotError(null);
    setSnapshotStatus(null);
    setSnapshotManagerOpen(true);
  }, [projectPath]);

  const handleCreateSnapshot = useCallback(async (label: string, kind: SnapshotInfo['kind'] = 'manual') => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      if (dirty && !(await handleSave())) return;
      const snapshot = await createProjectSnapshot(projectPath, label, kind);
      setSnapshotStatus(`快照已创建: ${snapshot.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`创建快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, dirty, handleSave, refreshSnapshots]);

  const handleRestoreSnapshot = useCallback(async (snapshot: SnapshotInfo) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      if (dirty && !(await handleSave())) return;
      await createProjectSnapshot(projectPath, 'before-restore', 'beforeRestore', `回滚到"${snapshot.label}"前自动备份`);
      await restoreProjectSnapshot(projectPath, snapshot.id);
      const info = await openProject(projectPath);
      setProjectInfo(info);
      void loadSceneHeaders(projectPath, info.scenes);
      void loadSceneLinkMap(projectPath, info.scenes);
      const restoredSceneName = info.scenes.includes(currentSceneName)
        ? currentSceneName
        : (info.scenes[0] ?? 'start.txt');
      setCurrentSceneName(restoredSceneName);
      const scenePath = await getScenePath(projectPath, restoredSceneName);
      const loaded = await loadScene(scenePath);
      setNodes(loaded);
      setScriptSource(await serializeScene(loaded));
      sceneDraftCache.current.clear();
      setDirty(false);
      setSelectedNode(null);
      setSnapshotStatus(`已回滚到"${snapshot.label}"，并自动创建 before-restore 备份。`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`回滚快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, dirty, handleSave, loadSceneHeaders, loadSceneLinkMap, currentSceneName, refreshSnapshots]);

  const handleRenameSnapshot = useCallback(async (snapshot: SnapshotInfo, label: string) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      const renamed = await renameProjectSnapshot(projectPath, snapshot.id, label);
      setSnapshotStatus(`快照已重命名: ${renamed.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`重命名快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, refreshSnapshots]);

  const handleDeleteSnapshot = useCallback(async (snapshot: SnapshotInfo) => {
    if (!projectPath || snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      await deleteProjectSnapshot(projectPath, snapshot.id);
      setSnapshotStatus(`快照已删除: ${snapshot.label}`);
      await refreshSnapshots();
    } catch (e) {
      setSnapshotError(`删除快照失败: ${e}`);
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectPath, snapshotBusy, refreshSnapshots]);

  const handleCreateExportCandidateSnapshot = useCallback(async () => {
    await handleCreateSnapshot(`candidate-${new Date().toISOString().slice(0, 10)}`, 'exportCandidate');
  }, [handleCreateSnapshot]);

  const handleOpenRuntime = useCallback(async () => {
    try {
      const url = await getRuntimeUrl();
      await openInBrowser(url);
    } catch (e) {
      console.warn('[runtime] failed to open browser:', e);
      alert(`无法打开预览窗口: ${e}`);
    }
  }, []);

  useEffect(() => {
    const action = searchParams.get('action');
    if (!action || loading || !projectPath) return;

    if (action === 'preview') {
      void handleOpenRuntime();
    } else if (action === 'export') {
      handleExportProject();
    } else {
      return;
    }

    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [
    handleExportProject,
    handleOpenRuntime,
    loading,
    projectPath,
    searchParams,
    setSearchParams,
  ]);

  const aiAgent = useAiAgent({
    projectId,
    projectPath,
    currentSceneName,
    nodes,
    selectedNode,
    scriptSource,
    dirty,
    characters: charactersForAi,
    setNodes,
    setScriptSource,
    setDirty,
    setSaveStatus,
    setSelectedNode,
    setShowScript,
    pushHistory,
  });

  useEffect(() => {
    aiPendingPreviewRef.current = aiAgent.pendingChange?.status === 'pending';
    if (aiAgent.status === 'reverted' || aiAgent.status === 'accepted') {
      sceneDraftCache.current.delete(currentSceneName);
    }
  }, [aiAgent.pendingChange?.status, aiAgent.status, currentSceneName]);

  const handleAiSend = () => { void aiAgent.sendPrompt(aiAgent.input); };
  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const gameName = projectInfo?.config?.Game_name || `项目 ${projectId ?? ''}`;

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="h-full story-shell">
        <StoryOsTopBar
          onUndo={undo}
          onRedo={redo}
          onRun={handleOpenRuntime}
          onPublish={handleExportProject}
          onSave={handleSave}
          onSearchChange={setCommandSearchQuery}
          searchValue={commandSearchQuery}
          searchPlaceholder="搜索指令 / 角色 / 内容..."
          saveStatus={saveStatus}
          onSettings={() => setAppSettingsOpen(true)}
        />
        <StoryOsSideNav
          active={viewMode === 'worldline' ? 'world' : 'script'}
          projectId={projectId}
          projectLabel={gameName}
          onCreate={handleNewScene}
        />

        <div className="story-os-workspace flex flex-col">
        {viewMode === 'worldline' ? (
          <FullScreenWorldline
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenScene={stableSwitchScene}
            onClose={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('view');
              setSearchParams(next, { replace: true });
            }}
            characterColors={characterColors}
            nodePositions={worldNodePositions}
            onUpdateNodePosition={updateWorldNodePosition}
            onAddSceneLink={addSceneLink}
            onRemoveSceneLink={removeSceneLink}
            onNewScene={handleNewScene}
            onDeleteScene={handleDeleteScene}
            onRenameScene={handleRenameScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
          />
        ) : (
          <>
        {/* Main Content */}
        <div className="relative flex-1 flex overflow-hidden">
          <SceneWorldlinePanel
            scenes={projectInfo?.scenes ?? [currentSceneName]}
            currentSceneName={currentSceneName}
            sceneHeaders={sceneHeaders}
            sceneLinkMap={sceneLinkMap}
            nodes={nodes}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenScene={stableSwitchScene}
            onOpenSceneManager={() => setSceneManagerOpen(true)}
            characterColors={characterColors}
            nodePositions={worldNodePositions}
            onUpdateNodePosition={updateWorldNodePosition}
            onAddSceneLink={addSceneLink}
            onRemoveSceneLink={removeSceneLink}
          />

          {/* Center - Script Command Stream / Script Source */}
          {showScript ? (
            <div className="flex-1 flex flex-col bg-background/50">
              <div className="p-3 border-b border-border flex items-center justify-between">
                <span className="text-sm text-muted-foreground font-mono-family">
                  WebGAL 脚本编辑器 - {currentSceneName}
                </span>
                <button
                  onClick={handleApplyScript}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all text-sm"
                >
                  应用更改
                </button>
              </div>
              <textarea
                value={scriptSource}
                onChange={(e) => setScriptSource(e.target.value)}
                className="flex-1 p-4 bg-transparent resize-none focus:outline-none text-sm leading-relaxed font-mono-family"
                spellCheck={false}
                aria-label="WebGAL 脚本编辑器"
              />
            </div>
          ) : (
            <ScriptCommandStream
              nodes={nodes}
              selectedNode={selectedNode}
              currentSceneName={currentSceneName}
              sceneHeaders={sceneHeaders}
              onSelectNode={setSelectedNode}
              onInsertNode={insertNode}
              onDeleteNode={deleteNode}
              onCopyNode={copyNode}
              onCutNode={cutNode}
              onPasteNode={pasteNode}
              onReorderNodes={reorderNodes}
              onJumpToIndex={jumpToNode}
              clipboardNode={clipboardNode}
              characterColors={characterColors}
              searchQuery={commandSearchQuery}
            />
          )}

          <AiAssistantPanel
            aiAgent={aiAgent}
            projectPath={projectPath}
            onOpenSettings={() => setAiSettingsOpen(true)}
            onSend={handleAiSend}
          />

          {selectedNode && !showScript && (
            <div className="absolute bottom-0 right-80 top-0 z-30 w-80 border-l border-border bg-surface-container-lowest shadow-[-8px_0_24px_rgba(25,28,30,0.06)]">
              <DetailPanel
                node={selectedNode}
                onUpdateNode={updateSelectedNode}
                onDeleteNode={deleteSelectedNode}
                onClose={() => setSelectedNode(null)}
                characterNames={charactersForAi.map((character) => character.name)}
                projectPath={projectPath ?? undefined}
                characters={charactersForAi}
                projectId={projectId}
              />
            </div>
          )}
        </div>

          <PerformanceTimeline
            nodes={nodes}
            selectedNodeId={selectedNode?.id}
            onSelectNode={(id) => {
              const found = nodes.find((node) => node.id === id);
              if (found) setSelectedNode(found);
            }}
          />
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container px-4 text-[10px] text-on-surface-variant/40">
            <div className="flex items-center gap-4">
              <span>{scriptSource.length.toLocaleString()} 字</span>
              <span>约 {Math.max(1, Math.ceil(scriptSource.length / 380))} 分钟阅读量</span>
              <span className="h-3 w-px bg-outline-variant/30" />
              <span>UTF-8 | LF | Engine: WebGAL</span>
            </div>
          </footer>
          </>
        )}
        </div>

        <AiSettingsDialog
          open={aiSettingsOpen}
          onClose={() => setAiSettingsOpen(false)}
        />

        <ProjectMetadataDialog
          open={projectMetadataOpen}
          projectName={projectName}
          initialMetadata={projectMetadata}
          saving={metadataSaving}
          exportTask={exportTask}
          onClose={() => setProjectMetadataOpen(false)}
          onSave={handleSaveProjectMetadata}
          onExport={handleExportProjectWithMetadata}
          onRetryExport={handleRetryExportProject}
        />

        <SnapshotManagerDialog
          open={snapshotManagerOpen}
          snapshots={snapshots}
          busy={snapshotBusy}
          error={snapshotError}
          status={snapshotStatus}
          onClose={() => setSnapshotManagerOpen(false)}
          onRefresh={refreshSnapshots}
          onCreate={handleCreateSnapshot}
          onCreateExportCandidate={handleCreateExportCandidateSnapshot}
          onRestore={handleRestoreSnapshot}
          onRename={handleRenameSnapshot}
          onDelete={handleDeleteSnapshot}
        />

        <SceneManagerPanel
          open={sceneManagerOpen}
          onClose={() => setSceneManagerOpen(false)}
          projectPath={projectPath ?? ''}
          projectInfo={projectInfo}
          currentSceneName={currentSceneName}
          sceneHeaders={sceneHeaders}
          onSwitchScene={stableSwitchScene}
          onHeaderUpdated={handleHeaderUpdated}
          onRefreshProject={refreshProjectInfo}
          onNewScene={handleNewScene}
        />

        <AppSettingsDialog
          open={appSettingsOpen}
          onClose={() => setAppSettingsOpen(false)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onApplyRuntimeTemplateDir={(dir) => setRuntimeTemplateDir(dir)}
        />

        <AlertDialog open={unsavedConfirmOpen} onOpenChange={(open) => { if (!open) handleUnsavedCancel(); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>有未保存的更改</AlertDialogTitle>
              <AlertDialogDescription>
                当前场景有未保存的内容，离开后将会丢失。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleUnsavedCancel}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { void handleUnsavedSaveAndLeave(); }}
                className="bg-primary text-primary-foreground"
              >
                保存并离开
              </AlertDialogAction>
              <AlertDialogAction
                onClick={handleUnsavedDiscard}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                直接离开
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </div>
    </DndProvider>
  );
}
