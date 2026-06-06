import { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  GitBranch,
  BookOpen,
  CornerDownRight,
  Plus,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Split,
  SlidersHorizontal,
  X,
  Image as ImageIcon,
  Music,
  Quote,
  MessageCircle,
  StickyNote,
  Heart,
  AlertTriangle,
  Rocket,
  Edit,
} from 'lucide-react';
import {
  StoryOsTopBar,
  type StoryOsSaveStatus,
} from './StoryOsChrome';

export interface WorldLineNode {
  id: string;
  /** Scene file basename (e.g. "chapter_01.txt") */
  scene: string;
  /** Display title in Chinese */
  title: string;
  /** Position on the canvas (px from top-left of node layer) */
  x: number;
  y: number;
  /** Optional kind: 序章 / 选择点 / 分支 / 结局 */
  kind: 'start' | 'choice' | 'branch' | 'ending';
  /** Variables / flags this node is gated by */
  flags?: Array<{ key: string; value: string; tone: 'positive' | 'negative' | 'neutral' }>;
  /** Scripted actions executed in this scene */
  actions?: Array<{
    id: string;
    index: number;
    label: string;
    kind: 'comment' | 'changeBg' | 'bgm' | 'narrator' | 'dialogue';
    summary: string;
    speaker?: string;
  }>;
}

export interface WorldLineEdge {
  from: string;
  to: string;
  /** Visual style hint for the connecting line */
  active?: boolean;
  /** Optional label for the edge (e.g. "信任>=50") */
  label?: string;
}

interface WorldLineViewProps {
  projectTitle?: string;
  projectId: string;
  initialNodes?: WorldLineNode[];
  initialEdges?: WorldLineEdge[];
  saveStatus?: StoryOsSaveStatus;
  onSave?: () => void;
}

const DEFAULT_NODES: WorldLineNode[] = [
  {
    id: 'n1',
    scene: 'prologue.txt',
    title: '初次相遇',
    x: 100,
    y: 110,
    kind: 'start',
    actions: [
      { id: 'a1', index: 1, label: '#1 注释', kind: 'comment', summary: '序章 —— 苍之歌姬' },
      { id: 'a2', index: 2, label: '#2 切换背景', kind: 'changeBg', summary: 'afternoon_park.webp' },
      { id: 'a3', index: 3, label: '#3 旁白', kind: 'narrator', summary: '放学后的庭院，阳光斜斜洒在长椅上。' },
    ],
  },
  {
    id: 'n2',
    scene: 'chapter_01.txt',
    title: '图书馆的对话',
    x: 450,
    y: 110,
    kind: 'choice',
    flags: [
      { key: 'trust_level', value: '>= 50', tone: 'positive' },
      { key: 'sys_alert_level', value: 'false', tone: 'neutral' },
    ],
    actions: [
      { id: 'b1', index: 1, label: '#1 注释', kind: 'comment', summary: '序章 —— 苍之歌姬' },
      { id: 'b2', index: 2, label: '#2 切换背景', kind: 'changeBg', summary: '765_office_dusk.webp' },
      { id: 'b3', index: 3, label: '#3 背景音乐', kind: 'bgm', summary: 'quiet_piano.mp3' },
      { id: 'b4', index: 4, label: '#4 旁白', kind: 'narrator', summary: '傍晚的 765 事务所，夕阳把排练室的玻璃染成了橘红色。' },
      { id: 'b5', index: 15, label: '#15 对话 : 最上静香', kind: 'dialogue', summary: '站在那里多久了？', speaker: '最上静香' },
    ],
  },
  {
    id: 'n3',
    scene: 'branch_a.txt',
    title: '拒绝邀请',
    x: 800,
    y: 50,
    kind: 'branch',
  },
  {
    id: 'n4',
    scene: 'branch_b.txt',
    title: '接受邀请',
    x: 800,
    y: 210,
    kind: 'branch',
  },
];

const DEFAULT_EDGES: WorldLineEdge[] = [
  { from: 'n1', to: 'n2' },
  { from: 'n2', to: 'n3', label: '拒绝' },
  { from: 'n2', to: 'n4', label: '接受', active: true },
];

function kindIcon(kind: WorldLineNode['kind']) {
  switch (kind) {
    case 'start':
      return BookOpen;
    case 'choice':
      return Split;
    case 'branch':
      return CornerDownRight;
    case 'ending':
      return Rocket;
  }
}

function kindLabel(kind: WorldLineNode['kind']) {
  switch (kind) {
    case 'start':
      return '序章';
    case 'choice':
      return '选择点';
    case 'branch':
      return '分支';
    case 'ending':
      return '结局';
  }
}

function actionIcon(kind: NonNullable<WorldLineNode['actions']>[number]['kind']) {
  switch (kind) {
    case 'comment':
      return StickyNote;
    case 'changeBg':
      return ImageIcon;
    case 'bgm':
      return Music;
    case 'narrator':
      return Quote;
    case 'dialogue':
      return MessageCircle;
  }
}

function buildEdgePath(from: WorldLineNode, to: WorldLineNode): string {
  const x1 = from.x + 200;
  const y1 = from.y + 40;
  const x2 = to.x;
  const y2 = to.y + 40;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

export function WorldLineView({
  projectTitle,
  projectId,
  initialNodes = DEFAULT_NODES,
  initialEdges = DEFAULT_EDGES,
  saveStatus = 'idle',
  onSave,
}: WorldLineViewProps) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState(initialNodes);
  const [edges] = useState(initialEdges);
  const [selectedId, setSelectedId] = useState<string | null>('n2');
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const adjustZoom = useCallback((delta: number) => {
    setZoom((current) => Math.min(1.6, Math.max(0.5, +(current + delta).toFixed(2))));
  }, []);

  const resetZoom = useCallback(() => setZoom(1), []);

  const addNewBranch = useCallback(() => {
    const id = `n${Date.now().toString(36)}`;
    const x = 800;
    const y = 300 + Math.floor(Math.random() * 200);
    setNodes((current) => [
      ...current,
      {
        id,
        scene: `branch_${id}.txt`,
        title: '新建分支',
        x,
        y,
        kind: 'branch',
      },
    ]);
    setSelectedId(id);
  }, []);

  const updateNodeField = useCallback(
    <K extends keyof WorldLineNode>(id: string, key: K, value: WorldLineNode[K]) => {
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, [key]: value } : node)));
    },
    [],
  );

  return (
    <div className="flex h-full w-full flex-col bg-surface text-foreground">
      <StoryOsTopBar
        title={projectTitle ?? `世界线 · ${projectId}`}
        onSave={onSave}
        saveStatus={saveStatus}
        onSettings={() => navigate('/')}
      />

      <div className="flex flex-1 min-h-0">
        <nav className="flex w-20 shrink-0 flex-col items-center border-r border-border bg-surface-container-lowest py-3">
          <button
            type="button"
            onClick={() => navigate(`/editor/${projectId}`)}
            className="mb-3 flex h-10 w-10 items-center justify-center rounded bg-primary text-primary-foreground"
            title="回到脚本"
          >
            <BookOpen className="h-5 w-5" />
          </button>
          <div className="h-px w-8 bg-border" />
          <button
            type="button"
            className="mt-3 flex flex-col items-center rounded bg-secondary-container/40 px-1 py-2 text-secondary"
            title="世界线"
            aria-current="page"
          >
            <GitBranch className="h-5 w-5" />
            <span className="mt-1 font-mono-family text-[8px] tracking-widest">WORLD</span>
          </button>
        </nav>

        <div
          ref={containerRef}
          className="relative flex-1 overflow-hidden bg-surface-container-low"
        >
          <div className="absolute inset-0 opacity-60 flow-grid pointer-events-none" />

          <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded border border-border bg-surface-container-lowest/90 px-3 py-2 backdrop-blur">
            <GitBranch className="h-4 w-4 text-secondary" />
            <span className="text-xs font-semibold text-foreground">世界线视图</span>
            <span className="h-4 w-px bg-border" />
            <span className="font-mono-family text-[10px] text-muted-foreground">
              {nodes.length} nodes · {edges.length} edges
            </span>
          </div>

          <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded border border-border bg-surface-container-lowest/90 p-1 backdrop-blur">
            <button
              type="button"
              onClick={() => adjustZoom(-0.1)}
              className="story-os-icon-button h-7 w-7"
              aria-label="缩小"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-[36px] text-center font-mono-family text-[10px] text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => adjustZoom(0.1)}
              className="story-os-icon-button h-7 w-7"
              aria-label="放大"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={resetZoom}
              className="story-os-icon-button h-7 w-7"
              aria-label="重置缩放"
              title="重置缩放"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>

          <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-2">
            <button
              type="button"
              onClick={addNewBranch}
              className="flex items-center gap-1 rounded bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-md hover:opacity-90 story-os-chamfer-tr"
            >
              <Split className="h-3.5 w-3.5" />
              新建分支
            </button>
          </div>

          <div className="absolute inset-0 overflow-auto">
            <div
              className="relative"
              style={{
                width: 1200,
                height: 800,
                transform: `scale(${zoom})`,
                transformOrigin: '0 0',
              }}
            >
              <svg
                className="pointer-events-none absolute inset-0"
                style={{ width: 1200, height: 800, zIndex: 0 }}
              >
                {edges.map((edge) => {
                  const from = nodes.find((n) => n.id === edge.from);
                  const to = nodes.find((n) => n.id === edge.to);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={`${edge.from}-${edge.to}`}
                      d={buildEdgePath(from, to)}
                      fill="none"
                      stroke={edge.active ? 'var(--color-primary, #a43758)' : 'var(--color-outline-variant, #dcc0c4)'}
                      strokeWidth={edge.active ? 3 : 2}
                    />
                  );
                })}
              </svg>

              {nodes.map((node) => {
                const Icon = kindIcon(node.kind);
                const isSelected = selectedId === node.id;
                const isChoice = node.kind === 'choice';
                return (
                  <button
                    type="button"
                    key={node.id}
                    onClick={() => setSelectedId(node.id)}
                    style={{ left: node.x, top: node.y, position: 'absolute', zIndex: isSelected ? 5 : 1 }}
                    className={`group flex w-[200px] flex-col rounded border bg-surface-container-lowest text-left shadow-sm transition-colors ${
                      isSelected
                        ? 'border-primary ring-2 ring-primary/30'
                        : isChoice
                          ? 'border-primary/60 hover:border-primary'
                          : 'border-outline-variant/50 hover:border-secondary'
                    }`}
                  >
                    <div
                      className={`absolute inset-x-0 top-0 h-1 rounded-t ${
                        isChoice
                          ? 'bg-primary'
                          : isSelected
                            ? 'bg-primary'
                            : 'bg-outline-variant/30'
                      }`}
                    />
                    <div className="p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Icon
                          className={`h-[18px] w-[18px] ${
                            isChoice || isSelected ? 'text-primary' : 'text-on-surface-variant'
                          }`}
                        />
                        <span
                          className={`font-mono-family text-[10px] tracking-widest ${
                            isChoice
                              ? 'font-bold text-primary'
                              : 'text-on-surface-variant'
                          }`}
                        >
                          {kindLabel(node.kind)}
                        </span>
                        {isChoice && (
                          <span className="ml-auto h-2 w-2 rounded-full bg-tertiary-container" />
                        )}
                      </div>
                      <h3 className="font-display-family text-sm font-semibold text-foreground leading-tight">
                        {node.title}
                      </h3>
                      <p className="mt-1 truncate font-mono-family text-[10px] text-muted-foreground">
                        {node.scene}
                      </p>
                      {node.flags && node.flags.length > 0 && (
                        <div className="mt-2 truncate rounded bg-surface-variant/30 px-1 py-0.5 font-mono text-[10px] text-on-surface-variant">
                          Flag: {node.flags.map((f) => f.key).join(' / ')}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-container-lowest/90 backdrop-blur-xl">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-[18px] w-[18px] text-on-surface" />
              <span className="font-display-family text-sm font-semibold text-foreground">节点检查器</span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-on-surface-variant hover:text-on-surface"
              aria-label="取消选择"
              title="取消选择"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>

          {selected ? (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              <div>
                <label className="mb-1 block font-mono-family text-[10px] tracking-widest text-on-surface-variant">
                  节点名称
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={selected.title}
                    onChange={(e) => updateNodeField(selected.id, 'title', e.target.value)}
                    className="flex-1 rounded border border-outline-variant/30 bg-surface-container px-3 py-2 text-sm text-foreground outline-none focus:border-secondary focus:ring-1 focus:ring-secondary"
                  />
                  <Edit className="h-3.5 w-3.5 text-on-surface-variant" />
                </div>
                <p className="mt-1 truncate font-mono-family text-[10px] text-muted-foreground">
                  {selected.scene}
                </p>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="font-mono-family text-[10px] tracking-widest text-on-surface-variant">
                    逻辑变量 (Variables)
                  </label>
                  <button
                    type="button"
                    className="text-primary hover:opacity-80"
                    aria-label="添加变量"
                    title="添加变量"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {(selected.flags ?? []).map((flag, idx) => {
                    const Icon = flag.tone === 'positive' ? Heart : flag.tone === 'negative' ? AlertTriangle : StickyNote;
                    const toneColor =
                      flag.tone === 'positive'
                        ? 'text-tertiary'
                        : flag.tone === 'negative'
                          ? 'text-error'
                          : 'text-on-surface-variant';
                    return (
                      <div
                        key={`${flag.key}-${idx}`}
                        className="flex items-center justify-between rounded border border-outline-variant/30 bg-surface-container px-2 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <Icon className={`h-4 w-4 ${toneColor}`} />
                          <span className="text-xs text-foreground">{flag.key}</span>
                        </div>
                        <span
                          className={`rounded px-1 font-mono text-[11px] ${
                            flag.tone === 'positive'
                              ? 'bg-secondary-container/30 text-secondary'
                              : 'bg-surface-variant text-on-surface'
                          }`}
                        >
                          {flag.value}
                        </span>
                      </div>
                    );
                  })}
                  {!(selected.flags && selected.flags.length > 0) && (
                    <p className="rounded border border-dashed border-outline-variant/50 bg-surface-container-low p-3 text-center text-[11px] text-muted-foreground">
                      暂无变量，点击 + 添加条件
                    </p>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="font-mono-family text-[10px] tracking-widest text-on-surface-variant">
                    执行动作 (Actions)
                  </label>
                  <button
                    type="button"
                    className="text-primary hover:opacity-80"
                    aria-label="添加动作"
                    title="添加动作"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="mb-3 flex flex-col gap-2">
                  {(selected.actions ?? []).map((action) => {
                    const Icon = actionIcon(action.kind);
                    const isPrimary = action.kind === 'bgm' || action.kind === 'dialogue';
                    return (
                      <div
                        key={action.id}
                        className={`flex items-start gap-2 rounded border p-2 ${
                          isPrimary
                            ? 'border-primary/30 bg-primary/5'
                            : 'border-outline-variant/30 bg-surface-container-low'
                        }`}
                      >
                        <Icon
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            isPrimary ? 'text-primary' : 'text-on-surface-variant'
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <div
                            className={`mb-1 font-mono-family text-[10px] ${
                              isPrimary ? 'text-primary' : 'text-on-surface-variant'
                            }`}
                          >
                            {action.label}
                          </div>
                          <div className="truncate text-xs text-foreground">{action.summary}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="w-full cursor-pointer rounded border border-dashed border-outline-variant p-3 text-center text-xs text-on-surface-variant transition-colors hover:bg-surface-container-low"
                >
                  <span className="flex items-center justify-center gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    添加脚本动作
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
              选择左侧画布上的节点以查看详情
            </div>
          )}

          <div className="border-t border-border p-3">
            <button
              type="button"
              className="w-full rounded bg-primary py-2 text-xs font-semibold text-primary-foreground shadow-[2px_2px_0_0_rgba(220,192,196,1)] hover:opacity-90 story-os-chamfer-tr"
            >
              应用更改
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function WorldLineRoute() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <WorldLineView projectId={projectId} />;
}
