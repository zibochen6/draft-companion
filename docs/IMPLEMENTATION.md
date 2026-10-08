# 稿伴 V0.1 实现说明

本文件保留首版历史记录。当前本地 0.2.0 见 [同版实现说明](IMPLEMENTATION_0.2.0.md)。

## 宿主与构建

使用 TypeScript、Obsidian 原生 `ItemView` 侧栏、`Modal` 与设置控件，不引入 React、通用 Agent 框架或浏览器网页壳。生产构建为单个 CommonJS `main.js`；Obsidian 和 Node 内建模块由桌面宿主提供。`styles.css` 使用 Obsidian 主题变量，界面为中文。

`manifest.json` 的 ID 为 `draft-companion`，显示名称为 `Draft Companion`，`isDesktopOnly: true`，`minAppVersion: 1.11.4`。所用 `App.secretStorage`、`SecretStorage`、`SecretComponent.setValue/onChange` 官方注解均为 1.11.4；`SecretComponent` 类本身注解为 1.11.1，不能据此下调本插件最低版本。编译使用的 typings 版本不是运行时最低版本。最低版本的真实实测情况见验证记录。

参考：[官方示例插件](https://github.com/obsidianmd/obsidian-sample-plugin)、[Manifest](https://docs.obsidian.md/Reference/Manifest)、[密钥管理指南](https://docs.obsidian.md/plugins/guides/secret-storage)、[官方 API 类型](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)。

## 文稿、请求与会话

文稿模块监听最近聚焦的 Markdown leaf；侧栏聚焦时保留绑定，启动及关闭原视图后用公开的 `getMostRecentLeaf()` 恢复可用目标。绑定指向 `TFile` 身份，运行时 UUID 与创建时间协助恢复；重命名更新路径，删除使旧候选及撤回记录失效。同名重建不能复用已删除文件的身份。

每次发送建立不可变快照：目标文件、全文、SHA-256、UTF-16 范围、选区、伙伴、Provider、模型、偏好、本文要求和历史。正文优先取编辑缓冲，避免只读到尚未保存的磁盘版本；同一文件的多个编辑视图内容不一致时拒绝继续。没有 source 编辑缓冲时读取 Vault 正文；阅读模式支持全文讨论与正文改稿，需要选区时请使用编辑模式。

最新全文在上下文信封中只放一份，局部选区另作范围材料；历史普通用户要求、模型回复和应用记录不会重复附带旧的全文信封。历史模型回复有材料与状态标签，旧角色规则不进入新一轮 system prompt。双链、嵌入、图片及 URL 不自动展开。

控制器一次只允许运行一个生成请求，以请求 ID 阻止停止后或卸载后的迟到数据。切换文稿时新文稿的会话与旧请求隔离；结果归属发送时文稿。所有伙伴共享本轮选定服务和模型，历史伙伴名称保留在消息元数据中。

本地数据通过官方 `loadData/saveData` 保存，包含多个 Provider 的非秘密字段、可编辑伙伴、偏好及按文稿隔离的会话。保存队列持有各次完整快照，失败不会阻塞后续保存。严格数据版本和结构检查在写回前完成；异常或不兼容版本拒绝启动并保留原数据。首次初始化才建立六个完整预设，不覆盖用户已编辑规则。

## 候选回写与撤回

改稿约定返回 `{ explanation: string, replacement: string, notes: string[] }`，只接受这些字段，不接受文件路径、任意命令、行号补丁或任意额外动作。正文与说明分开；空替换不作为模型删除指令。独立“删除当前范围”生成标记为删除的本地候选，仍须预览确认。

候选记录原始全文、全文哈希、冻结范围和完整替换内容。正文范围排除开头 YAML frontmatter，保留 BOM 与原换行；选区与 frontmatter 相交时拒绝。检查候选不会留下新的未闭合代码围栏。预览为行级差异，整批应用或放弃；新候选替代旧待应用候选。

存在编辑缓冲时，在同步全文比较后立即执行一个 `Editor.transaction` 范围变更，中间不插入异步操作。无编辑缓冲时使用 `Vault.process` 的同步原子回调，在回调内再次比较当前全文并确认文件身份及编辑模式。拒绝过时基线，无自动合并或强制覆盖入口。参考：[Editor](https://docs.obsidian.md/Plugins/Editor/Editor)、[Vault 原子读改写](https://docs.obsidian.md/Plugins/Vault)。

控制器对同一文稿的应用、撤回和删除候选操作设置互斥锁，避免重复点击或异步操作交叉改变基线与撤回记录；操作结束后释放锁。不同文稿的身份与会话仍各自隔离。

每篇文稿保留最近一次成功应用的撤回记录。撤回同样比较预期应用后全文，再恢复原范围；有后续编辑时拒绝覆盖并保留旧版本供查看。生成、应用、放弃、撤回、中断与失效均留下会话事件；清空会话保留本文要求、正文及最近撤回记录。

## 网络、密钥与渲染

Provider 层不依赖 Obsidian，统一用 Node `http/https.request` 实现模型列表、非流式和 SSE。Base URL 保留实际路径，只追加目标接口，不自动追加 `/v1`。默认只发送 `model/messages/stream`，不附加工具、推理或 JSON Schema 参数。模型列表区分认证、网络、接口不支持、格式、服务、上下文错误；聊天验证独立进行。

SSE 解析处理中文 UTF-8 跨分片、LF/CRLF、多行 data、usage 空 choices 与结束标记。没有完整结束原因或响应被截断时拒绝成功；`length`、`content_filter` 等非正常结束不会产生可应用候选。所有模式支持总超时、主动销毁连接和停止后屏蔽迟到响应，响应大小有上限；没有自动重试或自动跟随重定向。Node 请求不受浏览器 CORS 限制，但不会自动继承 Chromium 系统/PAC 代理。参考：[Node HTTP](https://nodejs.org/api/http.html)。

密钥选择使用官方 `SecretComponent`，普通插件数据仅保存 `secretRef`。实际密钥从 `app.secretStorage.getSecret()` 取用后仅放入 Authorization 请求头，不进入请求正文、记录或分发包；不扫描其他目录寻找密钥。错误提示不回显服务返回的原始内容，避免服务将文章或密钥回显到普通错误记录。本插件不对官方密钥底层存储方式作额外加密承诺。

会话与基线包含用户文章内容，存于本地插件数据，可能随用户同步方案同步；稿伴没有为这些普通数据自行加密。Markdown 显示关闭原始 HTML，拒绝执行模型脚本，不主动加载远程图片。文稿与历史文本是材料，不能改变插件决定的文件身份、编辑范围与应用行为。

## 验证与交付边界

模拟 HTTP 测试覆盖认证与列表格式分类、自定义路径、无重定向与无隐式重试、头部认证、中文分片流、正常与异常终止、压缩响应、固定请求配置、超时、取消和迟到结果。编辑与会话测试覆盖 YAML、范围、哈希、版本冲突、撤回、持久化与异常数据。实际通过数量和 GUI 验证以 `VERIFICATION.md` 为准。

本地模拟服务只监听 `127.0.0.1`，支持模型列表、聊天两种模式和固定测试任务。其 `/__requests` 仅内存保留合成测试消息，不记录 headers 或 Key，也不生成任何持久日志。合成文稿包含中文、emoji、frontmatter、双链、嵌入、图片占位与代码围栏，不含私人材料。

打包脚本只读取三个明确运行文件，不遍历目录，拒绝输入与输出符号链接，同时生成可安装目录 `dist/draft-companion/`、版本目录 `dist/draft-companion-版本/draft-companion/` 和 `dist/draft-companion-版本.zip`。两个安装目录和 ZIP 均只包含 `main.js/manifest.json/styles.css`；ZIP 根目录为插件 ID，不含 `data.json`、模拟记录、测试材料、源映射或凭据。ZIP 使用内建 CRC32 与无压缩存储格式，不依赖操作系统打包工具。

V0.1 不实现全库检索、联网抓取、原文持久批注、逐条补丁合并、公众号排版或后台发布。测试服务证明流程与协议行为，不能代替真实服务商的模型能力、实际网络环境或最低版本的安装验证。

最新本地迭代见 [0.4.0 智能与每日选题实现](IMPLEMENTATION_0.4.0.md)。
