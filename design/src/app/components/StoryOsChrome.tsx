import { useNavigate } from 'react-router';
import type * as React from 'react';
import {
  BookOpen,
  Boxes,
  Eye,
  GitBranch,
  Home,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  RotateCw,
  Settings,
  Upload,
  UserCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';

type StoryOsSection = 'home' | 'script' | 'world' | 'characters' | 'assets' | 'preview' | 'build';

interface StoryOsTopBarProps {
  title?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onRun?: () => void;
  onPublish?: () => void;
  onSettings?: () => void;
}

interface StoryOsSideNavProps {
  active: StoryOsSection;
  projectId?: string;
  projectLabel?: string;
  onCreate?: () => void;
}

interface StoryOsPanelProps {
  title: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
}

const navItems: Array<{ id: StoryOsSection; label: string; icon: LucideIcon }> = [
  { id: 'script', label: '脚本流', icon: BookOpen },
  { id: 'world', label: '世界线', icon: GitBranch },
  { id: 'characters', label: '立绘', icon: Users },
  { id: 'assets', label: '资源库', icon: Boxes },
  { id: 'preview', label: '预览', icon: Eye },
  { id: 'build', label: '导出', icon: Rocket },
];

export function StoryOsTopBar({
  title,
  onUndo,
  onRedo,
  onRun,
  onPublish,
  onSettings,
}: StoryOsTopBarProps) {
  const topActions = [
    { label: '撤销', icon: RotateCcw, handler: onUndo },
    { label: '重做', icon: RotateCw, handler: onRedo },
    { label: '运行预览', icon: Play, handler: onRun },
    { label: '导出/发布', icon: Upload, handler: onPublish },
  ].filter((action) => action.handler);

  return (
    <header className="story-os-topbar">
      <div className="flex min-w-0 items-center gap-4">
        <div className="font-display-family text-[22px] font-semibold leading-none tracking-normal text-primary">
          故事编辑室
        </div>
        {title && (
          <>
            <div className="h-4 w-px bg-border/70" />
            <div className="truncate text-sm font-medium text-foreground">{title}</div>
          </>
        )}
      </div>

      <nav className="hidden items-center gap-4 md:flex">
        {topActions.map(({ label, icon: Icon, handler }) => (
          <button
            key={label}
            type="button"
            onClick={handler}
            className="story-os-top-action"
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        {onSettings && (
          <button type="button" onClick={onSettings} className="story-os-icon-button" aria-label="设置">
            <Settings className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  );
}

export function StoryOsSideNav({ active, projectId, projectLabel = 'ALPHA', onCreate }: StoryOsSideNavProps) {
  const navigate = useNavigate();

  const handleNavigate = (target: StoryOsSection) => {
    if (target === 'home') {
      navigate('/');
      return;
    }
    if (!projectId) {
      alert('请先打开或创建项目。');
      return;
    }
    if (target === 'script') {
      navigate(`/editor/${projectId}`);
    } else if (target === 'characters') {
      navigate(`/editor/${projectId}/assets?tab=character`);
    } else if (target === 'assets') {
      navigate(`/editor/${projectId}/assets`);
    } else if (target === 'preview') {
      navigate(`/editor/${projectId}?action=preview`);
    } else if (target === 'build') {
      navigate(`/editor/${projectId}?action=export`);
    } else {
      alert('世界线模块尚未接入客户端页面，当前可在场景管理中维护剧本分支。');
    }
  };

  return (
    <aside className="story-os-sidenav">
      <div className="mb-4 mt-2 flex flex-col items-center gap-1 px-1 text-center" title={projectLabel}>
        <div className="story-os-avatar">
          {active === 'home' ? <Home className="h-6 w-6" /> : <UserCircle className="h-6 w-6" />}
        </div>
        <div className="text-[9px] font-semibold uppercase tracking-widest text-primary">
          STORY
        </div>
        <div className="w-full truncate text-[8px] text-muted-foreground opacity-70">
          {active === 'home' ? '创作者控制台' : '编辑中'}
        </div>
      </div>

      <nav className="flex w-full flex-1 flex-col gap-2">
        {navItems
          .filter(({ id }) => projectId || id === active)
          .map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            onClick={() => handleNavigate(id)}
            className={`story-os-nav-item ${active === id ? 'story-os-nav-item-active' : ''}`}
            aria-current={active === id ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {onCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="story-os-add-button mt-auto"
          aria-label="新建剧情分支"
          title="新建剧情分支"
        >
          <Plus className="h-5 w-5" />
        </button>
      )}
    </aside>
  );
}

export function StoryOsPanel({
  title,
  icon: Icon,
  action,
  children,
  className = '',
  headerClassName = '',
}: StoryOsPanelProps) {
  return (
    <section className={`story-os-panel ${className}`}>
      <header className={`story-os-panel-header ${headerClassName}`}>
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-primary" />}
          <span className="truncate">{title}</span>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
