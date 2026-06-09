# 素材库

`AssetManager` 是素材管理中心,集中浏览与管理所有素材。

## 功能

- **分类标签页**:场景(背景)、CG、音乐(子标签 BGM/音效/语音)、角色(立绘)。
- **上传**:支持多种格式——图像 PNG/JPG/WEBP/GIF/SVG,音频 MP3/OGG/WAV/FLAC/AAC,可批量上传。
- **配额**:2GB 存储配额,带百分比指示。
- **视图**:网格 / 列表切换;按文件名或别名搜索。
- **删除与用量提示**:删除素材时提示有多少对话节点引用了它,避免误删。

## 素材选择器

`AssetPicker` 用于在详情面板等处快速挑选:显示别名(回退文件名)、图像缩略图、音频时长,悬停试听(音量 0.45),并提供「清除引用」选项。

## 分类与 game/ 目录映射

| 分类 | 目录 |
|------|------|
| background | `game/backgrounds/` |
| figure(立绘) | `game/figure/` |
| bgm | `game/bgm/` |
| sfx(音效) | `game/sfx/` |
| vocal(语音) | `game/vocal/` |
| 参考素材 | `game/config/references/`(按分类 + 素材名) |

## 相关源码
- `design/src/app/components/AssetManager.tsx`、`design/src/app/components/AssetPicker.tsx`
- `design/src/app/lib/assets-ipc.ts`
