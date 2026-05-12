import { useState, useEffect, useCallback } from 'react';
import { Image, Search, Loader2 } from 'lucide-react';
import { listAssets, type AssetInfo } from '../lib/assets-ipc';
import { convertFileSrc } from '@tauri-apps/api/core';

interface Props {
  projectPath: string;
  category: string; // "background" | "figure" | "bgm" | "sfx"
  currentValue: string;
  onSelect: (filename: string) => void;
}

function isImageExt(ext: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some(e => ext.endsWith(e));
}

export function AssetPickerButton({ projectPath, category, currentValue, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAssets(projectPath, category);
      setAssets(result);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, category]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const filtered = assets.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-2 py-1.5 text-xs rounded bg-secondary hover:bg-secondary/70 transition-colors border border-border flex items-center gap-1"
        title="浏览素材库"
        aria-label="浏览素材库"
      >
        <Image className="w-3 h-3" />
        浏览
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 z-50 w-72 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            {/* Search */}
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索..."
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-input-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50"
                  autoFocus
                  aria-label="搜索素材"
                />
              </div>
            </div>

            {/* List */}
            <div className="max-h-48 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {search ? '无匹配素材' : '暂无素材，请先上传'}
                </div>
              ) : (
                <div className="p-1">
                  {/* Clear selection */}
                  <button
                    onClick={() => { onSelect('none'); setOpen(false); }}
                    className={`w-full px-2 py-1.5 rounded text-xs text-left hover:bg-secondary/50 transition-colors ${
                      currentValue === 'none' ? 'bg-primary/10 text-primary' : ''
                    }`}
                  >
                    （无 / 清除）
                  </button>
                  {filtered.map(asset => {
                    const thumb = isImageExt(asset.extension)
                      ? convertFileSrc(asset.path)
                      : null;
                    const isSelected = currentValue === asset.name;
                    return (
                      <button
                        key={asset.path}
                        onClick={() => { onSelect(asset.name); setOpen(false); }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-secondary/50 transition-colors ${
                          isSelected ? 'bg-primary/10 text-primary' : ''
                        }`}
                      >
                        <div className="w-8 h-8 rounded overflow-hidden bg-secondary/30 flex-shrink-0 flex items-center justify-center">
                          {thumb ? (
                            <img src={thumb} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <Image className="w-3 h-3 text-muted-foreground/30" />
                          )}
                        </div>
                        <span className="truncate">{asset.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
