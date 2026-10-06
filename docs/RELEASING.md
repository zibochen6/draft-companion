# 仓库、上架与版本更新

维护仓库：<https://github.com/zibochen6/draft-companion>。主分支：`main`。

## 首次发布

源码采用 MIT 许可。根目录包含 README、LICENSE、manifest、版本兼容表和完整源码；生成的 `main.js`、安装目录、ZIP 和本地依赖通过构建产生，不提交到源码历史。原始个人需求笔记留在本地。

版本 `0.1.0` 的 Release 标签必须是 `0.1.0`，不要添加 `v`。Release 独立附件包括：

- `main.js`
- `manifest.json`
- `styles.css`
- `draft-companion-0.1.0.zip`

前三个附件供 Obsidian 直接安装，ZIP 用于人工安装。只有 ZIP、源码归档或草稿 Release 都不足以完成市场安装。

## 社区目录首次提交

当前官方流程通过 [Obsidian Community](https://community.obsidian.md/) 提交，已不再向旧的 `obsidian-releases` 仓库创建收录 PR。

1. 使用维护者的 Obsidian 账户登录社区目录。
2. 在 Profile 的 GitHub 区域连接 `zibochen6`，验证仓库所有权。
3. Plugins → New plugin，仓库地址填写 `https://github.com/zibochen6/draft-companion`，Owner 选择自己。
4. 目录短、长描述使用英文，说明插件界面目前为中文；市场名称为 `Draft Companion`，插件 ID 为 `draft-companion`。目录当前只支持英文文本，市场搜索使用 `Draft Companion`。
5. 若要求支付分类，选择 Optional payment：插件免费，用户自选第三方模型服务可能需要付费；本地兼容服务也可用。
6. 阅读开发者政策，确认持续维护责任后提交，处理目录自动检查反馈并按要求发布。

**GitHub 发布完成不等于市场已经收录。** 审核及目录发布完成后，用户才能在 Obsidian 社区插件里搜索名称、作者或描述进行安装。上架状态以社区目录页面为准。

官方依据：[提交流程](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、[账户与仓库绑定](https://docs.obsidian.md/community-directory/set-up-and-claim)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[目录管理](https://docs.obsidian.md/community-directory/manage-entry)。

## 发布后续更新

例如准备 `0.1.2`：

```sh
npm run version:next -- 0.1.2
npm test
npm run package
npm run check:release -- --tag 0.1.2
```

升版脚本同步 `manifest.json`、`package.json`、`package-lock.json` 和 `versions.json`，保留旧版兼容映射；不会提交、创建标签或发布。若提高最低 Obsidian 版本，应同步当前 manifest 和当前版本的 versions 映射。

审查变化后提交并推送：

```sh
git add <本次修改的文件>
git commit -m "Release 0.1.2"
git push origin main
git tag -a 0.1.2 -m "Draft Companion 0.1.2"
git push origin 0.1.2
```

`main` 推送和 PR 只运行 CI。明确推送版本标签才触发发布工作流，重新安装依赖、运行检查与测试、生产构建、校验版本和安装文件，再上传四个附件发布 GitHub Release。Actions 使用仓库的自动令牌，不需要保存额外 API 密钥。编译文件保留项目及第三方版权许可声明。发布工作流为同一批四个附件生成 GitHub 构建来源证明，再上传附件。

不要更换插件 ID，也不要覆盖已发布版本的附件来冒充新版本。新 Release 后社区目录检查新版；必要时在目录管理页执行 Check for new releases / Request review。

## 用户如何更新

市场收录后，用户在 Obsidian 设置 → 社区插件 → 检查更新 → 更新。GitHub 上更新源码或发布版本不会强制覆盖用户本地插件；官方社区插件不会静默自动更新，插件也不能自行安装或更新自己。

参考：[Obsidian 官方更新说明](https://help.obsidian.md/Extending+Obsidian/Community+plugins)。

市场收录前，用户从 [GitHub Releases](https://github.com/zibochen6/draft-companion/releases/latest) 下载最新 ZIP，替换三个运行文件并重载插件。保留既有插件数据即可继续使用已有配置、会话和撤回记录。

## 当前发布状态（2026-10-07）

0.1.1 已正式发布到 GitHub；[官方目录条目](https://community.obsidian.md/plugins/draft-companion)已执行 Publish，0.1.1 自动审核 Completed，无阻断错误。官方网站以 `Draft Companion` 搜索已找到条目，匿名访问返回 HTTP 200。旧版客户端插件 JSON 列表当时仍未包含该 ID，客户端市场安装未实机验证；若客户端暂时搜不到，可从 Release 下载 ZIP 手动安装。发布字节与构建来源证明核对见 [验证记录](VERIFICATION.md)。
