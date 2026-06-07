import { useNavigate } from 'react-router';
import type * as React from 'react';
import {
  BookOpen,
  Boxes,
  Camera,
  Cloud,
  CloudOff,
  Eye,
  FileDown,
  FileUp,
  FolderOpen,
  GitBranch,
  Home,
  Loader2,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings,
  Upload,
  UserCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';

type StoryOsSection = 'home' | 'script' | 'world' | 'characters' | 'assets' | 'preview' | 'build';

export type StoryOsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface StoryOsTopBarProps {
  title?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onRun?: () => void;
  onPublish?: () => void;
  onSave?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onOpenProject?: () => void;
  onSnapshots?: () => void;
  onSearchChange?: (value: string) => void;
  searchValue?: string;
  searchPlaceholder?: string;
  saveStatus?: StoryOsSaveStatus;
  onSettings?: () => void;
}

interface StoryOsSideNavProps {
  active: StoryOsSection;
  projectId?: string;
  projectLabel?: string;
  onCreate?: () => void;
  onBeforeNavigate?: (action: () => void) => void;
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
  { id: 'world', label: '场景', icon: GitBranch },
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
  onSave,
  onImport,
  onExport,
  onOpenProject,
  onSnapshots,
  onSearchChange,
  searchValue,
  searchPlaceholder,
  saveStatus = 'idle',
  onSettings,
}: StoryOsTopBarProps) {
  const topActions = [
    { label: '撤销', icon: RotateCcw, handler: onUndo },
    { label: '重做', icon: RotateCw, handler: onRedo },
    { label: '运行预览', icon: Play, handler: onRun },
    { label: '导出/发布', icon: Upload, handler: onPublish },
    { label: '保存', icon: Save, handler: onSave, primary: true },
  ].filter((action) => action.handler);

  const secondaryActions = [
    { label: '打开项目', icon: FolderOpen, handler: onOpenProject },
    { label: '导入场景', icon: FileUp, handler: onImport },
    { label: '导出场景', icon: FileDown, handler: onExport },
    { label: '快照管理', icon: Camera, handler: onSnapshots },
  ].filter((action) => action.handler);

  const SaveIndicatorIcon =
    saveStatus === 'saving'
      ? Loader2
      : saveStatus === 'error'
        ? CloudOff
        : Cloud;
  const saveIndicatorTitle =
    saveStatus === 'saving'
      ? '保存中...'
      : saveStatus === 'saved'
        ? '已保存'
        : saveStatus === 'error'
          ? '保存失败'
          : '未保存';
  const saveIndicatorTone =
    saveStatus === 'error'
      ? 'text-error'
      : saveStatus === 'saved'
        ? 'text-tertiary'
        : 'text-muted-foreground';

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

      <nav className="hidden items-center gap-1 md:flex">
        {topActions.map(({ label, icon: Icon, handler, primary }) => (
          <button
            key={label}
            type="button"
            onClick={handler}
            className={
              primary
                ? 'story-os-top-action text-primary hover:text-primary'
                : 'story-os-top-action'
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
        {secondaryActions.length > 0 && (
          <>
            <div className="mx-1 h-4 w-px bg-border/40" />
            {secondaryActions.map(({ label, icon: Icon, handler }) => (
              <button
                key={label}
                type="button"
                onClick={handler}
                className="story-os-top-action text-muted-foreground hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
                <span className="hidden xl:inline">{label}</span>
              </button>
            ))}
          </>
        )}
      </nav>

      <div className="flex items-center gap-2">
        {onSearchChange && (
          <div className="story-os-top-search">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchValue ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder ?? '搜索...'}
              className="story-os-top-search-input"
              aria-label="搜索"
            />
          </div>
        )}
        {saveStatus !== 'idle' && (
          <span
            className={`flex h-8 w-8 items-center justify-center rounded ${saveIndicatorTone}`}
            title={saveIndicatorTitle}
            aria-label={saveIndicatorTitle}
          >
            <SaveIndicatorIcon
              className={`h-4 w-4 ${saveStatus === 'saving' ? 'animate-spin' : ''}`}
            />
          </span>
        )}
        {onSettings && (
          <button type="button" onClick={onSettings} className="story-os-icon-button" aria-label="设置">
            <Settings className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  );
}

export function StoryOsSideNav({ active, projectId, projectLabel = 'ALPHA', onCreate, onBeforeNavigate }: StoryOsSideNavProps) {
  const navigate = useNavigate();

  const doNavigate = (target: StoryOsSection) => {
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
    } else if (target === 'world') {
      navigate(`/editor/${projectId}?view=worldline`);
    } else {
      alert('该模块尚未接入。');
    }
  };

  const handleNavigate = (target: StoryOsSection) => {
    if (onBeforeNavigate) {
      onBeforeNavigate(() => doNavigate(target));
    } else {
      doNavigate(target);
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
