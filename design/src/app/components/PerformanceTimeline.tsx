import { useMemo, useState } from 'react';
import {
  Database,
  Music,
  Image as ImageIcon,
  MessageCircle,
  Terminal,
  Ruler,
  X,
  Maximize2,
} from 'lucide-react';
import type { WebGalNode } from '../lib/webgal-types';
import { isMetadataComment } from '../lib/webgal-types';

export type PerformanceTimelineTab = 'performance' | 'commands' | 'variables';

interface PerformanceTimelineProps {
  nodes: WebGalNode[];
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  height?: number;
  onClose?: () => void;
}

const TRACKS: Array<{
  id: 'background' | 'bgm' | 'voice';
  label: string;
  icon: typeof Music;
  types: ReadonlyArray<WebGalNode['type']>;
  tone: 'secondary' | 'tertiary' | 'primary';
}> = [
  { id: 'background', label: '背景', icon: ImageIcon, types: ['changeBg'], tone: 'secondary' },
  { id: 'bgm', label: 'BGM', icon: Music, types: ['bgm'], tone: 'tertiary' },
  {
    id: 'voice',
    label: '台词/语音',
    icon: MessageCircle,
    types: ['dialogue', 'changeFigure', 'setAnimation', 'playEffect'],
    tone: 'primary',
  },
];

// Assign each visible node a "duration" in seconds, used to position the
// timeline block. Lines / metadata / branch choices are short; dialogue and
// changeBg are longer; commands that should "hold" get bigger slices.
function estimateDuration(node: WebGalNode): number {
  if (isMetadataComment(node)) return 0.4;
  switch (node.type) {
    case 'changeBg':
      return 4.0;
    case 'bgm':
      return 8.0;
    case 'dialogue':
      return 3.5;
    case 'changeFigure':
    case 'setAnimation':
    case 'playEffect':
      return 2.0;
    case 'choose':
      return 5.0;
    default:
      return 1.5;
  }
}

function blockLabel(node: WebGalNode): string {
  if (node.type === 'dialogue') {
    return node.content || '...';
  }
  if (node.type === 'changeBg') return node.asset || node.content || '背景';
  if (node.type === 'bgm') return node.asset || node.content || 'BGM';
  if (node.type === 'changeFigure') return node.asset || node.content || '立绘';
  if (node.type === 'setAnimation') return node.content || node.asset || '动画';
  if (node.type === 'playEffect') return node.content || node.asset || '特效';
  if (node.type === 'choose') return node.content || '分支选择';
  if (isMetadataComment(node)) return node.content?.trim() || '注释';
  return node.type;
}

const TONE_BG: Record<'secondary' | 'tertiary' | 'primary', string> = {
  secondary: 'bg-secondary-container/50 border-secondary/40 text-secondary',
  tertiary: 'bg-tertiary-container/30 border-tertiary/40 text-tertiary',
  primary: 'bg-primary-container/30 border-primary/40 text-primary',
};

export function PerformanceTimeline({
  nodes,
  selectedNodeId,
  onSelectNode,
  height = 160,
  onClose,
}: PerformanceTimelineProps) {
  const [activeTab, setActiveTab] = useState<PerformanceTimelineTab>('performance');
  const [collapsed, setCollapsed] = useState(false);

  const visibleNodes = useMemo(
    () => nodes.map((node, index) => ({ node, index })),
    [nodes],
  );

  const totalDuration = useMemo(
    () => visibleNodes.reduce((sum, { node }) => sum + estimateDuration(node), 0) || 1,
    [visibleNodes],
  );

  const tracks = useMemo(() => {
    return TRACKS.map((track) => {
      const segments: Array<{ node: WebGalNode; index: number; start: number; end: number }> = [];
      let cursor = 0;
      for (const { node, index } of visibleNodes) {
        if (!track.types.includes(node.type)) continue;
        const dur = estimateDuration(node);
        const start = cursor;
        const end = cursor + dur;
        segments.push({ node, index, start, end });
        cursor = end;
      }
      return { ...track, segments };
    });
  }, [visibleNodes]);

  const rulerSteps = useMemo(() => {
    const steps: number[] = [];
    const stepCount = 5;
    for (let i = 0; i <= stepCount; i++) {
      steps.push((totalDuration * i) / stepCount);
    }
    return steps;
  }, [totalDuration]);

  const variableNodes = useMemo(
    () => visibleNodes.filter(({ node }) => node.type === 'setVar' || node.type === 'callScene' || node.type === 'label'),
    [visibleNodes],
  );

  const commandNodes = useMemo(
    () => visibleNodes.filter(({ node }) => !isMetadataComment(node)),
    [visibleNodes],
  );

  if (collapsed) {
    return (
      <nav
        className="story-os-timeline flex shrink-0 items-center justify-between border-t border-outline-variant bg-surface-container px-4"
        style={{ height: 32 }}
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
          <Ruler className="h-4 w-4" />
          时间线
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded p-1 hover:bg-surface-container-high"
          aria-label="展开时间线"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </nav>
    );
  }

  return (
    <nav
      className="story-os-timeline flex shrink-0 flex-col border-t border-outline-variant bg-surface-container"
      style={{ height }}
    >
      <div className="flex h-8 shrink-0 items-center gap-6 border-b border-outline-variant/50 bg-surface-container-low px-md text-xs">
        <TabButton
          active={activeTab === 'performance'}
          onClick={() => setActiveTab('performance')}
          icon={Ruler}
        >
          演出轨道
        </TabButton>
        <TabButton
          active={activeTab === 'commands'}
          onClick={() => setActiveTab('commands')}
          icon={Terminal}
        >
          指令模式
        </TabButton>
        <TabButton
          active={activeTab === 'variables'}
          onClick={() => setActiveTab('variables')}
          icon={Database}
        >
          变量
        </TabButton>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-on-surface-variant/60">
          {activeTab === 'performance' && (
            <span>
              总时长 ≈ {totalDuration.toFixed(1)}s · {visibleNodes.length} 节点
            </span>
          )}
          {activeTab === 'commands' && <span>{commandNodes.length} 条指令</span>}
          {activeTab === 'variables' && <span>{variableNodes.length} 条变量/控制流</span>}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 hover:bg-surface-container-high"
            aria-label="折叠时间线"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden bg-surface-bright">
        {activeTab === 'performance' && (
          <div className="absolute inset-0 flex flex-col">
            <div className="flex h-5 shrink-0 items-end border-b border-outline-variant/30 bg-surface-container-lowest pl-24 text-[10px] text-outline">
              {rulerSteps.map((seconds, idx) => (
                <span
                  key={idx}
                  className="flex w-20 shrink-0 items-center border-l border-outline-variant/30 px-1"
                >
                  {formatTime(seconds)}
                </span>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-1 overflow-y-auto py-1">
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="flex h-8 items-center border-y border-outline-variant/20 bg-surface-container-low"
                >
                  <div className="flex w-24 shrink-0 items-center gap-1 border-r border-outline-variant/30 bg-surface-container-lowest px-2 text-[10px] font-mono-family text-on-surface-variant">
                    <track.icon className="h-3.5 w-3.5" />
                    {track.label}
                  </div>
                  <div className="relative h-full flex-1">
                    {track.segments.length === 0 ? (
                      <span className="flex h-full items-center px-3 text-[10px] text-on-surface-variant/40">
                        无相关指令
                      </span>
                    ) : (
                      track.segments.map((seg) => {
                        const left = (seg.start / totalDuration) * 100;
                        const width = ((seg.end - seg.start) / totalDuration) * 100;
                        const isSelected = selectedNodeId === seg.node.id;
                        return (
                          <button
                            key={seg.node.id}
                            type="button"
                            onClick={() => onSelectNode?.(seg.node.id)}
                            className={`absolute top-1/2 flex h-5 -translate-y-1/2 items-center truncate border px-1 text-[10px] transition-shadow ${
                              TONE_BG[track.tone]
                            } ${isSelected ? 'shadow-[0_0_0_2px_rgba(164,55,88,0.4)]' : 'hover:shadow-sm'}`}
                            style={{ left: `${left}%`, width: `${Math.max(width, 6)}%` }}
                            title={blockLabel(seg.node)}
                          >
                            {blockLabel(seg.node)}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'commands' && (
          <div className="absolute inset-0 overflow-y-auto p-3 font-mono-family text-[11px] leading-relaxed">
            {commandNodes.length === 0 ? (
              <p className="text-muted-foreground">当前场景暂无指令</p>
            ) : (
              <ol className="space-y-1">
                {commandNodes.map(({ node, index }) => (
                  <li
                    key={node.id}
                    className={`flex items-center gap-2 rounded px-2 py-1 ${
                      selectedNodeId === node.id
                        ? 'bg-primary-container/30 text-primary'
                        : 'text-on-surface hover:bg-surface-container-low'
                    }`}
                  >
                    <span className="w-6 shrink-0 text-right text-[10px] text-outline">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="rounded bg-secondary-container/40 px-1.5 py-0.5 text-[9px] uppercase text-secondary">
                      {node.type}
                    </span>
                    <span className="truncate">{blockLabel(node)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {activeTab === 'variables' && (
          <div className="absolute inset-0 overflow-y-auto p-3 text-xs">
            {variableNodes.length === 0 ? (
              <p className="text-muted-foreground">
                暂无变量 / 流程控制指令。剧本中调用 setVar、if、callScene 等指令后会出现在这里。
              </p>
            ) : (
              <ul className="space-y-1">
                {variableNodes.map(({ node, index }) => (
                  <li
                    key={node.id}
                    className="flex items-center justify-between border-b border-outline-variant/30 py-1"
                  >
                    <span className="text-on-surface-variant">
                      #{index + 1} · {node.type}
                    </span>
                    <span className="font-mono-family text-tertiary">{blockLabel(node)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

function TabButton({
  active,
  onClick,
  children,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon: typeof Ruler;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1 text-xs font-bold transition-colors ${
        active
          ? 'border-b-2 border-tertiary text-tertiary'
          : 'text-on-surface-variant/60 hover:text-tertiary'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
