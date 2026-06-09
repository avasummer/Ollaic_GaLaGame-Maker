import { memo, useMemo } from 'react';
import type { SceneLink } from '../lib/webgal-types';
import type { SceneHeader } from '../lib/webgal-ipc';

// Scene graph layout constants (SVG coordinate space). GRAPH_W is parametrized
// (graphWidth prop) so the same graph can render narrow in the side panel and
// wider in the full-screen view; everything else matches the master layout.
const NODE_H = 14;
const MAX_NODE_W = 58;
const MIN_NODE_W = 26;
const NODE_RX = 3;
const NODE_GAP_X = 4;
const ROW_H = 30;
const TOP_PAD = 12;
const BOTTOM_PAD = 12;
const SIDE_PAD = 8;

interface NodePos {
  x: number;
  y: number;
  w: number;
}

interface SceneGraphLayout {
  positions: Map<string, NodePos>;
  edges: { from: string; to: string }[];
  height: number;
}

/**
 * Lay out scenes by BFS depth from the project's start scene.
 * The root is intentionally NOT the current scene — using the current scene
 * would shift the whole graph whenever the user switches scenes.
 */
function computeSceneGraphLayout(
  scenes: string[],
  linksByScene: Record<string, SceneLink[]>,
  graphWidth: number,
): SceneGraphLayout {
  const positions = new Map<string, NodePos>();
  const edges: { from: string; to: string }[] = [];

  if (scenes.length === 0) {
    return { positions, edges, height: TOP_PAD + BOTTOM_PAD };
  }

  // Fixed start so positions are stable regardless of which scene is open.
  const startScene = scenes.includes('start.txt') ? 'start.txt' : scenes[0];

  const depths = new Map<string, number>();
  const byDepth: string[][] = [];
  const queue: { name: string; depth: number }[] = [{ name: startScene, depth: 0 }];
  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    while (byDepth.length <= depth) byDepth.push([]);
    byDepth[depth].push(name);
    for (const link of linksByScene[name] ?? []) {
      if (scenes.includes(link.target) && !depths.has(link.target)) {
        queue.push({ name: link.target, depth: depth + 1 });
      }
    }
  }

  const orphans = scenes.filter((s) => !depths.has(s));
  if (orphans.length > 0) {
    byDepth.push(orphans);
    for (const s of orphans) depths.set(s, byDepth.length - 1);
  }

  const innerW = graphWidth - 2 * SIDE_PAD;
  byDepth.forEach((row, depth) => {
    const y = TOP_PAD + NODE_H / 2 + depth * ROW_H;
    const count = row.length;
    const ideal = (innerW - (count - 1) * NODE_GAP_X) / count;
    const blockW = Math.max(MIN_NODE_W, Math.min(MAX_NODE_W, ideal));
    const slotW = blockW + NODE_GAP_X;
    const totalW = slotW * count - NODE_GAP_X;
    const startX = SIDE_PAD + (innerW - totalW) / 2;
    row.forEach((name, i) => {
      const x = startX + i * slotW + blockW / 2;
      positions.set(name, { x, y, w: blockW });
    });
  });

  const seen = new Set<string>();
  for (const [from, ls] of Object.entries(linksByScene)) {
    if (!positions.has(from)) continue;
    for (const link of ls) {
      if (!positions.has(link.target)) continue;
      const key = `${from}→${link.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to: link.target });
    }
  }

  const height = byDepth.length > 0
    ? TOP_PAD + NODE_H + (byDepth.length - 1) * ROW_H + BOTTOM_PAD
    : TOP_PAD + BOTTOM_PAD;
  return { positions, edges, height };
}

/**
 * Build a right-angle (orthogonal) SVG path between two graph nodes.
 * - Direct vertical when source and target share a column
 * - "Elbow" via a mid-row horizontal bus when going down
 * - Routes around the side when going up / sideways (back-edges, cycles)
 */
function buildOrthogonalPath(from: NodePos, to: NodePos, graphWidth: number): string {
  const halfH = NODE_H / 2;
  const startY = from.y + halfH + 1;
  const endY = to.y - halfH - 2;

  if (endY > startY + 4) {
    if (Math.abs(from.x - to.x) < 0.5) {
      return `M ${from.x},${startY} V ${endY}`;
    }
    const midY = (startY + endY) / 2;
    return `M ${from.x},${startY} V ${midY} H ${to.x} V ${endY}`;
  }

  // Same row or back-edge: detour through the side margin
  const exitY = from.y + halfH + 6;
  const enterY = to.y - halfH - 6;
  const sideX = from.x <= to.x ? graphWidth - 4 : 4;
  return `M ${from.x},${startY} V ${exitY} H ${sideX} V ${enterY} H ${to.x} V ${endY}`;
}

interface SceneGraphProps {
  scenes: string[];
  currentSceneName?: string;
  /** Saved-on-disk outgoing links per scene. Stable across scene switches & edits;
   *  updated only when a scene is saved (see StoryEditor.handleSave). */
  sceneLinkMap?: Record<string, SceneLink[]>;
  sceneHeaders?: Record<string, SceneHeader>;
  onSwitchScene?: (name: string) => void;
  /** Right-click on a node (used by the full-screen view for rename / delete). */
  onNodeContextMenu?: (name: string, e: React.MouseEvent) => void;
  /** viewBox width — narrow (224) for the side panel, larger for full-screen. */
  graphWidth?: number;
  /** Classes for the scroll container (height, borders, …). */
  className?: string;
}

/**
 * Static, non-draggable scene relationship graph (BFS-depth layout + orthogonal
 * edges). Ported from master's NodePanel SceneGraph. Layout depends only on
 * saved data, so switching scenes / editing nodes never rebuilds it.
 */
export const SceneGraph = memo(function SceneGraph({
  scenes,
  currentSceneName,
  sceneLinkMap,
  sceneHeaders,
  onSwitchScene,
  onNodeContextMenu,
  graphWidth = 224,
  className,
}: SceneGraphProps) {
  const layout = useMemo(
    () => computeSceneGraphLayout(scenes, sceneLinkMap ?? {}, graphWidth),
    [scenes, sceneLinkMap, graphWidth],
  );

  return (
    <div className={`relative overflow-auto overflow-x-hidden ${className ?? ''}`}>
      {layout.positions.size === 0 ? (
        <div className="py-6 text-center font-mono-family text-[10px] text-muted-foreground/60">
          (无场景)
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${graphWidth} ${layout.height}`}
          preserveAspectRatio="xMidYMin meet"
          style={{ width: '100%', height: 'auto', aspectRatio: `${graphWidth} / ${layout.height}` }}
          className="block"
        >
          <defs>
            <marker id="scene-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="var(--color-primary)" />
            </marker>
          </defs>
          {layout.edges.map((e, i) => {
            const from = layout.positions.get(e.from)!;
            const to = layout.positions.get(e.to)!;
            return (
              <path
                key={`${e.from}->${e.to}-${i}`}
                d={buildOrthogonalPath(from, to, graphWidth)}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth={1.4}
                strokeOpacity={0.85}
                strokeLinejoin="round"
                strokeLinecap="round"
                markerEnd="url(#scene-arrow)"
              />
            );
          })}
          {[...layout.positions.entries()].map(([name, pos]) => {
            const isCurrent = name === currentSceneName;
            const header = sceneHeaders?.[name];
            const display = header?.chapter?.trim() || name.replace(/\.txt$/i, '');
            const maxChars = Math.max(3, Math.floor(pos.w / 4.2) - 1);
            const label = display.length > maxChars
              ? display.slice(0, Math.max(1, maxChars - 1)) + '…'
              : display;
            const titleParts = [name];
            if (header?.chapter) titleParts.push(`章节：${header.chapter}`);
            if (header?.outline) titleParts.push(`大纲：${header.outline}`);
            return (
              <g
                key={name}
                onClick={() => onSwitchScene?.(name)}
                onContextMenu={onNodeContextMenu ? (e) => { e.preventDefault(); onNodeContextMenu(name, e); } : undefined}
                className="cursor-pointer"
              >
                <title>{titleParts.join('\n')}</title>
                <rect
                  x={pos.x - pos.w / 2}
                  y={pos.y - NODE_H / 2}
                  width={pos.w}
                  height={NODE_H}
                  rx={NODE_RX}
                  ry={NODE_RX}
                  className={
                    isCurrent
                      ? 'fill-primary stroke-primary'
                      : 'fill-primary/15 stroke-primary/40 hover:fill-primary/30 transition-colors'
                  }
                  strokeWidth={0.7}
                />
                <text
                  x={pos.x}
                  y={pos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="7"
                  className={
                    isCurrent
                      ? 'fill-primary-foreground font-mono-family pointer-events-none'
                      : 'fill-foreground/85 font-mono-family pointer-events-none'
                  }
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
});
