import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, ChevronDown, Volume2, Music } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { WebGalNode, ChoiceBranch } from '../lib/webgal-types';

interface Props {
  /** Initial scene file to load, e.g. "start.txt" */
  initialScene: string;
  projectPath: string;
  onClose: () => void;
  /** Callback to load a scene by filename. PreviewOverlay calls this to follow scene transitions. */
  onLoadScene: (sceneName: string) => Promise<WebGalNode[]>;
}

interface FigureState {
  asset: string;
  position: 'left' | 'center' | 'right';
  id: string;
}

/** Stack frame for callScene — remembers where to return. */
interface SceneFrame {
  nodes: WebGalNode[];
  returnIdx: number;
  sceneName: string;
}

function assetUrl(projectPath: string, category: string, name: string): string {
  if (!name || name === 'none') return '';
  return convertFileSrc(`${projectPath}/game/${category}/${name}`);
}

/** Resolve audio path: tries primary category first, then falls back to bgm. */
function audioUrl(projectPath: string, categories: string[], name: string): string | null {
  if (!name || name === 'none') return null;
  for (const cat of categories) {
    const url = assetUrl(projectPath, cat, name);
    // We can't check existence from renderer, so return the first match.
    return url;
  }
  return null;
}

export function PreviewOverlay({ initialScene, projectPath, onClose, onLoadScene }: Props) {
  // --- scene execution state ---
  const [nodes, setNodes] = useState<WebGalNode[]>([]);
  const [sceneName, setSceneName] = useState(initialScene);
  const [loaded, setLoaded] = useState(false);
  const sceneStackRef = useRef<SceneFrame[]>([]);
  const loadingRef = useRef(false);

  // --- rendering state ---
  const [bg, setBg] = useState<string | null>(null);
  const [figures, setFigures] = useState<FigureState[]>([]);
  const [textbox, setTextbox] = useState<{ speaker?: string; text: string } | null>(null);
  const [textboxVisible, setTextboxVisible] = useState(true);
  const [choices, setChoices] = useState<ChoiceBranch[] | null>(null);
  const [introLines, setIntroLines] = useState<string[] | null>(null);
  const [introIndex, setIntroIndex] = useState(0);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [nodeIdx, setNodeIdx] = useState(0);
  const [ended, setEnded] = useState(false);
  const [bgmLabel, setBgmLabel] = useState<string | null>(null);
  const [bgmSrc, setBgmSrc] = useState<string | null>(null);
  const [effectLabel, setEffectLabel] = useState<string | null>(null);
  const [effectSrc, setEffectSrc] = useState<string | null>(null);
  const [waitingForClick, setWaitingForClick] = useState(false);

  // Audio refs
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const sfxAudioRef = useRef<HTMLAudioElement | null>(null);

  // --- labels map for current nodes ---
  const labelMap = useMemo(() => {
    const map: Record<string, number> = {};
    nodes.forEach((n, idx) => {
      if (n.type === 'label' && n.labelName) {
        map[n.labelName] = idx;
      }
    });
    return map;
  }, [nodes]);

  // --- Load initial scene ---
  useEffect(() => {
    let cancelled = false;
    loadingRef.current = true;
    onLoadScene(initialScene).then(loadedNodes => {
      if (cancelled) return;
      setNodes(loadedNodes);
      setSceneName(initialScene);
      setNodeIdx(0);
      setEnded(false);
      setLoaded(true);
      loadingRef.current = false;
    });
    return () => { cancelled = true; };
  }, [initialScene, onLoadScene]);

  // --- evaluate when condition ---
  const evalWhen = useCallback((when: string | undefined): boolean => {
    if (!when) return true;
    try {
      const expr = when.trim();
      const ops = ['>=', '<=', '!=', '==', '>', '<'];
      for (const op of ops) {
        const idx = expr.indexOf(op);
        if (idx === -1) continue;
        const left = expr.slice(0, idx).trim();
        const right = expr.slice(idx + op.length).trim();
        const lv = vars[left] || '0';
        const rv = right.replace(/^["']|["']$/g, '');
        const ln = parseFloat(lv);
        const rn = parseFloat(rv);

        switch (op) {
          case '==': return lv === rv;
          case '!=': return lv !== rv;
          case '>=': return ln >= rn;
          case '<=': return ln <= rn;
          case '>': return ln > rn;
          case '<': return ln < rn;
        }
      }
    } catch { /* fall through */ }
    return true;
  }, [vars]);

  // --- Load a new scene (for changeScene / callScene / choose targets) ---
  const switchToScene = useCallback(async (target: string, pushReturn: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const newNodes = await onLoadScene(target);

      if (pushReturn) {
        // callScene: push current position to stack
        sceneStackRef.current.push({
          nodes,
          returnIdx: nodeIdx + 1, // resume AFTER the callScene command
          sceneName,
        });
      } else {
        // changeScene or choose-to-scene: clear the stack
        sceneStackRef.current = [];
      }

      setNodes(newNodes);
      setSceneName(target);
      setNodeIdx(0);
      setBg(null);
      setFigures([]);
      setTextbox(null);
      setChoices(null);
      setIntroLines(null);
      setEnded(false);
      setWaitingForClick(false);
      // Note: vars, bgm are preserved across scene changes
    } catch {
      setTextbox({ text: `[无法加载场景: ${target}]` });
      setWaitingForClick(true);
    } finally {
      loadingRef.current = false;
    }
  }, [nodes, nodeIdx, sceneName, onLoadScene]);

  // --- Return from callScene ---
  const returnFromCall = useCallback(() => {
    const frame = sceneStackRef.current.pop();
    if (!frame) {
      setEnded(true);
      return;
    }
    setNodes(frame.nodes);
    setSceneName(frame.sceneName);
    setNodeIdx(frame.returnIdx);
    setChoices(null);
    setWaitingForClick(false);
    setBg(null);
    setFigures([]);
    setTextbox(null);
    setIntroLines(null);
    // Audio keeps playing (BGM is global)
  }, []);

  // --- Process a single node ---
  const processNode = useCallback((node: WebGalNode): 'continue' | 'wait' | 'end' | 'switch' => {
    if (!evalWhen(node.when)) {
      return 'continue';
    }

    const autoAdvance = node.next === true;

    switch (node.type) {
      case 'comment':
        return 'continue';

      case 'changeBg': {
        const name = node.asset || node.content;
        setBg(name || null);
        break;
      }

      case 'changeFigure': {
        const asset = node.asset || node.content;
        const pos = node.figurePosition || 'center';
        const figId = node.figureId || pos;

        setFigures(prev => {
          if (!asset || asset === 'none') {
            return prev.filter(f => f.id !== figId);
          }
          const existing = prev.find(f => f.id === figId);
          if (existing) {
            return prev.map(f => f.id === figId ? { ...f, asset, position: pos } : f);
          }
          return [...prev, { asset, position: pos, id: figId }];
        });
        break;
      }

      case 'miniAvatar':
        break;

      case 'bgm': {
        const name = node.asset || node.content;
        if (!name || name === 'none') {
          setBgmLabel(null);
          setBgmSrc(null);
        } else {
          setBgmLabel(name);
          const src = assetUrl(projectPath, 'bgm', name);
          setBgmSrc(src);
        }
        break;
      }

      case 'playEffect': {
        const name = node.asset || node.content;
        if (name && name !== 'none') {
          setEffectLabel(name);
          // SFX from sfx/ directory, fallback to bgm/
          const src = assetUrl(projectPath, 'sfx', name) || assetUrl(projectPath, 'bgm', name);
          setEffectSrc(src);
        }
        break;
      }

      case 'playVideo': {
        setTextbox({ text: `[视频: ${node.asset || node.content || '(无名称)'}]` });
        setWaitingForClick(true);
        return 'wait';
      }

      case 'dialogue': {
        const speaker = node.character || undefined;
        const text = node.content;
        setTextbox({ speaker, text });
        if (!autoAdvance) {
          setWaitingForClick(true);
          return 'wait';
        }
        break;
      }

      case 'narrator': {
        setTextbox({ text: node.content });
        if (!autoAdvance) {
          setWaitingForClick(true);
          return 'wait';
        }
        break;
      }

      case 'intro': {
        const lines = node.introLines || [node.content];
        setIntroLines(lines);
        setIntroIndex(0);
        setWaitingForClick(true);
        return 'wait';
      }

      case 'choose': {
        if (node.choices && node.choices.length > 0) {
          setChoices(node.choices);
          setWaitingForClick(true);
          return 'wait';
        }
        break;
      }

      case 'label':
        break;

      case 'jumpLabel': {
        const target = node.labelName || node.content;
        if (target && labelMap[target] !== undefined) {
          setChoices(null);
          setWaitingForClick(false);
          const targetIdx = labelMap[target];
          // Immediate jump — handled by advance / useEffect
          queueMicrotask(() => setNodeIdx(targetIdx));
          return 'continue';
        }
        break;
      }

      case 'setVar': {
        const varName = typeof node.varName === 'string' ? node.varName.trim() : '';
        if (varName) {
          setVars(prev => ({ ...prev, [varName]: node.varValue || '' }));
        }
        break;
      }

      case 'setTextbox': {
        if (node.content === 'hide') setTextboxVisible(false);
        else setTextboxVisible(true);
        break;
      }

      case 'getUserInput': {
        setTextbox({ text: `[用户输入: ${node.inputTitle || node.content || ''}]` });
        setWaitingForClick(true);
        return 'wait';
      }

      case 'setAnimation': {
        setEffectLabel(`动画: ${node.animationName || node.content || ''}`);
        setTimeout(() => setEffectLabel(null), 2000);
        break;
      }

      case 'setTransform':
        break;

      case 'changeScene': {
        const target = node.targetScene || node.content;
        if (target) {
          switchToScene(target, false);
          return 'switch';
        }
        break;
      }

      case 'callScene': {
        const target = node.targetScene || node.content;
        if (target) {
          switchToScene(target, true);
          return 'switch';
        }
        break;
      }

      case 'end': {
        // If we have a stack, return to caller; otherwise end the game
        if (sceneStackRef.current.length > 0) {
          queueMicrotask(() => returnFromCall());
          return 'switch';
        }
        setEnded(true);
        setWaitingForClick(false);
        return 'end';
      }

      case 'unlockCg':
      case 'unlockBgm':
        break;
    }

    return 'continue';
  }, [evalWhen, labelMap, projectPath, switchToScene, returnFromCall]);

  // --- Advance to next node ---
  const advance = useCallback(() => {
    setChoices(null);
    setWaitingForClick(false);

    const current = nodes[nodeIdx];
    if (!current) {
      setEnded(true);
      return;
    }

    const nextIds = current.connections;
    let nextNode: WebGalNode | undefined;
    if (nextIds.length > 0) {
      nextNode = nodes.find(n => n.id === nextIds[0]);
    }

    if (!nextNode) {
      // No connections in this scene — end or return from call
      if (sceneStackRef.current.length > 0) {
        returnFromCall();
        return;
      }
      setEnded(true);
      return;
    }

    const nextIdx = nodes.indexOf(nextNode);
    if (nextIdx === -1) {
      if (sceneStackRef.current.length > 0) {
        returnFromCall();
        return;
      }
      setEnded(true);
      return;
    }

    setNodeIdx(nextIdx);
  }, [nodeIdx, nodes, returnFromCall]);

  // --- Audio playback: BGM ---
  useEffect(() => {
    const audio = bgmAudioRef.current;
    if (!audio) return;
    if (bgmSrc) {
      audio.src = bgmSrc;
      audio.loop = true;
      audio.volume = 0.6;
      audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.src = '';
    }
  }, [bgmSrc]);

  // --- Audio playback: SFX ---
  useEffect(() => {
    const audio = sfxAudioRef.current;
    if (!audio) return;
    if (effectSrc) {
      audio.src = effectSrc;
      audio.loop = false;
      audio.volume = 0.8;
      audio.play().catch(() => {});
      setEffectSrc(null); // one-shot, clear after play
    }
  }, [effectSrc]);

  // --- Click to continue ---
  const handleClick = useCallback(() => {
    if (ended || choices) return;

    if (introLines && introIndex < introLines.length - 1) {
      setIntroIndex(i => i + 1);
      return;
    }
    if (introLines) {
      setIntroLines(null);
      setIntroIndex(0);
      advance();
      return;
    }

    advance();
  }, [ended, choices, introLines, introIndex, advance]);

  // --- Choose handler ---
  const handleChoice = useCallback(async (choice: ChoiceBranch) => {
    setChoices(null);
    setWaitingForClick(false);

    if (!choice.target) {
      advance();
      return;
    }

    // If target is a .txt file, switch to that scene
    if (choice.target.endsWith('.txt')) {
      switchToScene(choice.target, false);
      return;
    }

    // Try label jump in current scene
    if (labelMap[choice.target] !== undefined) {
      setNodeIdx(labelMap[choice.target]);
      return;
    }

    const labelNode = nodes.find(n => n.type === 'label' && n.labelName === choice.target);
    if (labelNode) {
      setNodeIdx(nodes.indexOf(labelNode));
      return;
    }

    // No match
    setTextbox({ text: `[跳转: → ${choice.target}]` });
    setWaitingForClick(true);
  }, [advance, labelMap, nodes, switchToScene]);

  // --- Process current node ---
  useEffect(() => {
    if (ended || !loaded) return;
    if (nodeIdx < 0 || nodeIdx >= nodes.length) {
      setEnded(true);
      return;
    }

    const node = nodes[nodeIdx];
    if (!node) {
      setEnded(true);
      return;
    }

    if (waitingForClick || choices) return;

    const result = processNode(node);

    if (result === 'continue') {
      advance();
    }
    // 'wait', 'end', 'switch' handled by state setters
  }, [nodeIdx, ended, nodes, processNode, advance, waitingForClick, choices, loaded]);

  // --- Keyboard ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleClick();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClick, onClose]);

  // --- Figure position class ---
  const figurePosClass = (pos: string) => {
    switch (pos) {
      case 'left': return 'left-[8%]';
      case 'right': return 'right-[8%]';
      default: return 'left-1/2 -translate-x-1/2';
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black select-none font-body-family"
      onClick={handleClick}
    >
      {/* Hidden audio elements */}
      <audio ref={bgmAudioRef} />
      <audio ref={sfxAudioRef} />

      {/* Background */}
      {bg && (
        <img
          src={assetUrl(projectPath, 'background', bg)}
          className="absolute inset-0 w-full h-full object-cover transition-all duration-700"
          alt=""
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      {!bg && (
        <div className="absolute inset-0 bg-gradient-to-b from-gray-900 to-gray-800" />
      )}

      {/* Figures */}
      {figures.map((fig) => (
        <img
          key={fig.id}
          src={assetUrl(projectPath, 'figure', fig.asset)}
          className={`absolute bottom-[15%] max-h-[70%] max-w-[35%] object-contain transition-all duration-500 ${figurePosClass(fig.position)}`}
          alt=""
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ))}

      {/* BGM indicator */}
      {bgmLabel && (
        <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 text-white/60 text-xs flex items-center gap-2">
          <Music className="w-3 h-3" />
          {bgmLabel}
        </div>
      )}

      {/* Effect indicator */}
      {effectLabel && (
        <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 text-white/60 text-xs flex items-center gap-2">
          <Volume2 className="w-3 h-3" />
          {effectLabel}
        </div>
      )}

      {/* Intro overlay */}
      {introLines && (
        <div className="absolute inset-0 bg-black flex items-center justify-center z-10">
          <p className="text-white/90 text-2xl text-center px-12 transition-opacity duration-500 animate-in fade-in font-display-family">
            {introLines[introIndex]}
          </p>
        </div>
      )}

      {/* Choices */}
      {choices && !introLines && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-20 bg-black/30">
          <p className="text-white/70 text-lg mb-2">做出选择</p>
          {choices.map((c, idx) => (
            <button
              key={idx}
              onClick={(e) => { e.stopPropagation(); handleChoice(c); }}
              className="px-8 py-3 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 text-white hover:bg-white/20 transition-all hover:scale-105 min-w-[280px] text-lg"
              aria-label={`选择: ${c.text}`}
            >
              {c.text}
            </button>
          ))}
        </div>
      )}

      {/* Textbox */}
      {textboxVisible && textbox && !introLines && !choices && !ended && (
        <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
          <div className="max-w-4xl mx-auto bg-black/70 backdrop-blur-md rounded-xl border border-white/10 p-6">
            {textbox.speaker && (
              <div className="text-primary text-sm mb-2 font-display-family">
                {textbox.speaker}
              </div>
            )}
            <p className="text-white/90 text-lg leading-relaxed">{textbox.text}</p>
          </div>

          <div className="absolute bottom-3 right-6 animate-bounce">
            <ChevronDown className="w-5 h-5 text-white/40" />
          </div>
        </div>
      )}

      {/* Ended screen */}
      {ended && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-20">
          <p className="text-white/60 text-2xl mb-4 font-display-family">
            游戏结束
          </p>
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-white/10 border border-white/20 text-white/80 hover:bg-white/20 transition-all"
            aria-label="返回编辑器"
          >
            返回编辑器
          </button>
        </div>
      )}

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/40 backdrop-blur-sm border border-white/10 text-white/60 hover:text-white hover:bg-black/60 transition-colors z-30"
        aria-label="关闭preview"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Hint */}
      {!ended && !choices && !introLines && (
        <div className="absolute top-4 left-4 text-white/20 text-xs z-10">
          点击或按空格键继续 · Esc 退出
        </div>
      )}
    </div>
  );
}
