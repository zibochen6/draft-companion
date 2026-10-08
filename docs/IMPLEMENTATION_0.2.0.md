# 稿伴 0.2.0 实现说明

继续沿用 TypeScript、原生 Obsidian `ItemView`/控件、现有 Node HTTP/HTTPS 传输和官方 SecretStorage。未引入 React、数据库或 Agent 框架。

## 协议与数据

`review-protocol.ts` 在当前角色规则之上附加运行时审稿协议，使用普通聊天接口。只接收完整 JSON（允许外层单个完整 JSON 代码围栏），严格限制字段。路径、编号、身份、偏移、授权范围和写入权限由插件产生。`null` 为仅评论；空替换不能用于删除。角色原规则不被改写，最新全文只注入一次，处理记录和用户拒绝会进入后续上下文。

`review-types.ts` 定义审阅轮次、建议、不可变原作者、新版本、回复、锚点与局部应用回执。schema 2 校验拒绝未知字段、跨文稿关联、缺失版本、重复 ID 和损坏位置。`Store.migrate` 先验证 schema 1，再等待调用方完成原始字节备份；持久化仍为串行完整快照。全文只存在中央运行时版本、当前旧式整篇候选及最近整篇撤回记录，不为每条批注重复持久化。

## 定位、版本与应用

`review-anchors.ts` 在冻结全文内枚举精确原句匹配，结合短前后文和授权范围消歧，拒绝第一个匹配和模糊匹配。原句、关键上下文、依据和授权边界分别映射。每个文稿使用连续 before/after 版本链，after 已匹配视为多窗格回声，before 不匹配或未知外部编辑则保守失效。请求期间保留变更链，断链后的旧回复只能重新审阅。

`reviews.ts` 负责候选合并、完整重复统计、版本替代、只读预览、互斥写入、自动下一条和逐条撤回。应用前先持久化进行中状态，最后在 `Documents.applyRangeValidated` 的同步比较与编辑器事务 / `Vault.process` 回调内验证身份、全文、锚点和 frontmatter。写回后保存局部回执；保存失败时保留内存回执并明确提示，重启保守转为待检查。整篇候选保留严格全文比较，不能覆盖后续局部修改。

## 编辑器与视图

`editor-review.ts` 通过公开 `editorInfoField` 与 `registerEditorExtension` 绑定实际文件和 EditorView。CM/原始字符坐标明确转换，检查 UTF-16 代理对与 CRLF 边界。重叠高亮合并，独立 gutter 显示批注编号；普通点击被动选择，拖选、修饰键和组词不触发。高亮始终依据完整锚点，视口变化后仍有效；刷新延迟到微任务，关闭视图与禁用插件清理注册。

`sidebar.ts` 管理紧凑对话/批注界面；业务行为委托 UIHost。`review-view.ts` 提供固定文稿身份的独立只读审阅标签和当前建议预览。原文、改后调用既有安全 Markdown 渲染；`revision-render.ts` 比较安全 DOM 结构，用 `Intl.Segmenter` 字素差异生成受控 ins/del，结构变化以带文字标签的前后块显示。展示 DOM 从不参与写入，图片、嵌入和双链保持惰性引用。

显式开发依赖锁定 `@codemirror/state@6.5.0`、`@codemirror/view@6.38.6`；构建排除 `@codemirror/*`、`@lezer/*`，使用宿主核心运行时。最低版本仍为 Obsidian 1.11.4，实际验证环境及限制见同版验证记录。

实机 CRLF 验证发现公开 Editor/View 保存均会统一成 LF，切换阅读模式也会触发保存，因此 source 写入增加显式保护：预读原文件含 CRLF 时拒绝写回；只有无 source 缓冲且文件仍为 CRLF 时可走原始 Vault 原子更新。坐标转换保证不误画/误切，但不能改变或还原宿主自行保存的换行。缓存选区带版本哈希，不能将旧 LF 选区套到不同的原始 CRLF 文件。
