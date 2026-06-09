# 修改预览与应用

AI 的所有写操作不会直接改动磁盘,而是聚合成一个**待确认变更集(PendingChangeSet)**,由用户在卡片中预览、同意或拒绝后才原子应用。

## 变更集聚合

所有暂存编辑(场景、角色、记忆、新建场景)合并为单个 `PendingChangeSet`。场景编辑包含修改前/后节点、diff(基于 LCS 计算)以及素材校验。
- 实现:`lib/change-set.ts`(`stageSceneEdit` 等)、`finalizeChangeSet`(`useAiAgent.ts`)。

## 预览展示

- **变更卡片** `AiPendingCard` / `ChangeSetCard`:汇总全部变更(数量 + 每项明细)。场景编辑显示**节点级 diff**——新增/修改/删除的节点卡(带命令图标),原始文本 diff 可折叠展开。
- **主画布预览**:当待确认变更涉及当前打开的场景时,主画布以只读形式渲染节点 diff(绿=新增 / 红=删除 / 黄=修改),用 `PreviewNodeCard` 完整呈现;聊天面板内用紧凑的 `MiniNodeCard`。

## 同意 / 拒绝 / 冲突

- **同意**:`acceptChange` 触发原子落盘。
- **拒绝**:`revertChange` 丢弃暂存。
- **冲突**:若在变更待确认期间用户手动改了当前场景,会出现冲突卡 `ConflictCard`,提供三选项:保留手动修改 / 应用 AI(覆盖)/ 基于最新状态重新生成(`regenerateAfterConflict` 会预填提示词)。

## 缺失素材

若补丁引用了素材库中不存在的资源,`MissingAssetCard` 提供:使用兜底素材 / 打开素材库 / 重试该提示。
- 实现:`stageSceneEdit`(`change-set.ts`)、`AiStatusCard.tsx`。

## 原子落盘

`persistChangeSet` 按「场景 → 角色 → 记忆」顺序写入;任一步失败则回滚之前的修改;新建场景(会产生新文件)放在最后,避免失败时残留孤儿文件。
- 实现:`persistChangeSet`(`useAiAgent.ts`)。

## 相关源码
- `design/src/app/lib/change-set.ts`、`design/src/app/lib/editor-patch.ts`
- `design/src/app/hooks/useAiAgent.ts`(`finalizeChangeSet` / `acceptChange` / `revertChange` / `forceApplyChange` / `persistChangeSet`)
- `design/src/app/components/AiPendingCard.tsx`、`AiStatusCard.tsx`、`MiniNodeCard.tsx`、`PreviewNodeCard.tsx`
- `design/src/app/lib/node-diff.ts`(节点级 diff)
