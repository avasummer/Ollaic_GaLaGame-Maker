/**
 * Shared node-display helpers: icon, type color, and one-line summary for a
 * WebGalNode. Single source of truth for editor node lists and the AI
 * change-preview MiniNodeCard.
 */

import {
  MessageCircle, GitBranch, Image as ImageIcon, User, Music, Film, Tag,
  ArrowRight, Type, Monitor, Variable, Keyboard, Wand2, Move, Award,
} from 'lucide-react';
import type { WebGalNode, WebGalCommandType } from './webgal-types';
import { typeBorderClass } from './webgal-types';

export const commandIcons: Partial<Record<WebGalCommandType, typeof MessageCircle>> = {
  dialogue: MessageCircle,
  narrator: Type,
  intro: Monitor,
  choose: GitBranch,
  changeBg: ImageIcon,
  changeFigure: User,
  miniAvatar: User,
  changeScene: ArrowRight,
  callScene: ArrowRight,
  end: ArrowRight,
  bgm: Music,
  playEffect: Music,
  playVideo: Film,
  label: Tag,
  jumpLabel: Tag,
  setVar: Variable,
  setTextbox: Monitor,
  getUserInput: Keyboard,
  setAnimation: Wand2,
  setTransform: Move,
  unlockCg: Award,
  unlockBgm: Award,
  comment: Type,
};

/** Border + faint background classes per command type. Re-exported as
 *  typeColors for backwards-compat with consumers like MiniNodeCard. */
export const typeColors: Partial<Record<WebGalCommandType, string>> = typeBorderClass;

/** One-line human summary of a node's payload. */
export function getNodeSummary(node: WebGalNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.character ? `${node.character}: ${node.content}` : node.content;
    case 'narrator':
      return node.content;
    case 'changeBg':
    case 'changeFigure':
    case 'miniAvatar':
      return node.asset || node.content;
    case 'choose':
      return node.choices?.map(c => c.text).join(' / ') || node.content;
    case 'changeScene':
    case 'callScene':
      return node.targetScene || node.content;
    case 'label':
    case 'jumpLabel':
      return node.labelName || node.content;
    case 'setVar':
      return node.varName ? `${node.varName} = ${node.varValue}` : node.content;
    case 'intro':
      return node.introLines?.join(' | ') || node.content;
    case 'bgm':
    case 'playEffect':
    case 'playVideo':
      return node.asset || node.content;
    case 'setAnimation':
      return node.animationName || node.content;
    case 'comment':
      return node.content;
    default:
      return node.content || '—';
  }
}
