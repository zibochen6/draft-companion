# BigPengSays/bigpeng-hot-gzh 方法来源

稿伴的“选题编辑”可选方法块参考了 [BigPengSays/bigpeng-hot-gzh](https://github.com/BigPengSays/bigpeng-hot-gzh) 的公开结构：八种选题模板、七种标题角度，以及标题承诺需要由正文兑现的检查思路。上游仓库的作者为 BigPeng，许可证为 MIT；核对日期为 2026-10-07。许可原文保存在 [bigpeng-hot-gzh-LICENSE.txt](./bigpeng-hot-gzh-LICENSE.txt)。

这里是为稿伴改写后的可编辑提示词，不包含上游的 45 条标题语料，也不会执行上游仓库中面向其他工具的安装、搜索或调用指令。改写保留了以下边界：

- 该方法用于生成选题和暂定标题，不写正文或大纲。
- 它不保证爆款、点击率或跨行业效果；18–32 字和前 16 字信息完整只是可放宽的经验建议。
- 只有用户提供的真实材料可以支撑第一人称、数字、收益、对比、社会证明和附赠物。
- 稿伴当前没有联网搜索和事实核查能力，因此不会模拟热点搜索，也会把外部事实标为待用户核实。

实现位于 [src/topic-method.ts](../../src/topic-method.ts)。方法块写进角色配置后仍可由用户在 Obsidian 设置中编辑；升级函数只在缺少稳定标记时追加，不替换已有自定义规则。
