# 场景关系图

以**不可拖动**的关系图展示场景间的跳转关系,点击节点即可切换场景。

## 布局与渲染

- **自动布局**:以 `start.txt`(否则首个场景)为根做 **BFS 分层**,每层一行、行内均匀居中;无入边的孤立场景归到末行。布局仅依赖已保存数据,切换场景/编辑不会重排。
- **纯 SVG**:节点为圆角矩形(当前场景高亮),连线为**正交直角路径 + 箭头**;节点大小随容器宽度自适应缩放。
- **节点标签**:优先显示章节名(`chapter`),否则显示文件名;悬停 `<title>` 显示文件名/章节/大纲。

## 连线

由 `sceneLinkMap` 推导:每条 `changeScene`/`callScene`/`choose` 目标生成一条边。**目标按精确文件名匹配场景**——目标值须等于真实场景文件名才会连线(在详情面板用[场景下拉选择器](../editor/node-editing.md)可保证一致)。

## 交互

- **点击**节点:切换/打开该场景。
- **内嵌面板** `SceneWorldlinePanel`:左侧小图 + 当前场景的指令索引列表。
- **全屏视图** `FullScreenWorldline`:更大的关系图 + 工具栏(返回、场景计数、新建、管理)+ 右侧当前场景索引;**节点右键菜单**支持切换/重命名/删除场景。

## 相关源码
- `design/src/app/components/SceneGraph.tsx`(`computeSceneGraphLayout` / `buildOrthogonalPath`)
- `design/src/app/components/StoryEditor.tsx`(`SceneWorldlinePanel` / `FullScreenWorldline`)
