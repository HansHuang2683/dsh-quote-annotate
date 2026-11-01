# 划选引用与批注（dsh-quote-annotate）

DeepSeek Harness Web 插件：**划选 → 悬浮批注 → 原文高亮 + 编号角标 → 输入框上方一条「N 条批注」**，
发送时把每条批注（原文 + 你的话）自动折叠进消息。手感对齐 Codex / GitHub PR review。

[English →](README.md)

## 怎么用

1. 在任意消息里**划选**一段文字 → 选区上方浮出 **「批注」** 按钮（拖动过程中不出现，松手才出现）
2. 点**「批注」** → 选区旁弹出悬浮批注框（原文预览 + 输入框 + Cancel / Save；`⌘/Ctrl+Enter` 保存，`Esc` 取消）
3. 点 **Save** 后：
   - 原文出现**浅蓝高亮**，行尾出现**编号角标** ①（点角标可再次编辑）
   - 输入框正上方出现与输入框等宽的一条 **「1 条批注 · 发送时会自动附在消息里」**，点开可看列表：编辑 ✎ / 定位原文 ↗ / 删除 × / 清空
4. 重复第 1 步，可以有第 2、3… 条批注，编号各自独立
5. **发送时**（Enter 或点发送按钮）自动把批注折叠成正文，例如：

   ```text
   我的问题……

   【我的批注】

   批注 1｜AI 回复 · 第 3 轮
   原文：
      XX 参数目前写的是 0.5
   批注：这个应该是 0.7，因为……
   ```

   输入框里始终只放你自己写的字，预览干净；发出去的消息里批注逐条带**出处（谁说的 + 第几轮）**，
   模型能准确对上是哪一句话。

6. **兜底**：批注条右侧的「插入正文」永远可用 —— 把批注块直接写进输入框，再正常发送，不会丢。

## 实现要点

- 只用官方 seam：`shell.overlay`（工具条 / 批注框 / 角标 / **批注条**）、`conversation.input.overlay`
  （一个渲染 null 的「输入桥」，只把 `inputActions` 与当前草稿暴露给共享 bridge）、标准 props
  `useInput` / `inputActions`（`setDraft` / `submit`）。
- 颜色只用主题 token，但**填充色**刻意用 `--dsw-static-deepseek-500`：
  `--dsw-alias-brand-primary` 在深色主题里是「白色」，拿它当填充色会出现「白底白字」。
- **浅色 / 深色两套调色板**：优先读宿主 `theme` 服务的 `getTheme().active.colorScheme`，
  并在 `theme/change` 时重绘；服务不可用时退化为「读 body 上 `--dsw-alias-bg-base` 的亮度」，最后才是 `prefers-color-scheme`。
  所有自带控件（工具条 / 批注框 / 角标 / 批注条）都用插件自己的 `--dqa-*` 变量，两套主题各一份值。
- 原文高亮用 **CSS Custom Highlight API**（`CSS.highlights`），**不包裹、不修改别人的 DOM**；
  角标是悬浮层里的绝对定位元素，靠 `Range.getClientRects()` 定位，滚动 / 缩放 / 流式渲染时自动重算。
- 批注条**不再依赖 `conversation.input.dock`**：该槽位在热更新后出现过「注册还在但 `active: false`」的失效挂载，
  导致悬浮层有批注、输入框那半边却是空的。现在批注条渲染在根级 `shell.overlay` 里，用 `[data-composer-card]`
  的位置把自己贴在输入框正上方并按输入框宽度对齐；发送拦截在 `apply()` 时做模块级安装（document 捕获监听），
  不依赖任何组件是否挂载。
- 共享状态（批注列表 / bridge / 折叠锁）挂在 `window.__DSH_QUOTE_ANNOTATE_SHARED__`，避免 HMR 换包后
  两半来自不同模块世代时各持一份，互相看不见。
- 定位原文优先用「行内文本偏移」（创建时算好），失效时回退到首行文本搜索。
- 发送折叠：捕获阶段监听 Enter（排除 Shift / IME / 组合键）与「输入框卡片里最右侧的启用按钮」，
  先 `setDraft(正文 + 批注块)`，轮询确认草稿已发布，再调用 `inputActions.submit()` 提交 ——
  不赌原生发送的时序。
- 草稿为空但有批注时，写入一个零宽占位符让原生发送按钮可用（发送时剔除）。

## 目录

| 文件 | 作用 |
|---|---|
| `client.js` | 全部前端逻辑 |
| `index.js` | Host 半边，故意留空，只负责让宿主挂载 `dsh.client` 入口 |
| `cordis.patch.yml` | bundle patch，插入 `quote-annotate` 一行 |
| `locale/{zh,en}.json` | 插件管理页显示的名称与描述 |
| `icon.svg` | 插件图标 |

## 安装

需要 DeepSeek Harness **0.2.1-rc.3 或更新**（Web / 桌面端 Web UI）。

用 `plugin_manager` 工具（或插件页 →「添加插件」）：

```text
action: install_bundle
target: https://github.com/HansHuang2683/dsh-quote-annotate
```

也可以指向本地目录，或指向打包好的 tarball：

```bash
pnpm pack --pack-destination dist
# 然后 install_bundle, target: <绝对路径>/dist/dsh-quote-annotate-1.0.0.tgz
```

安装后刷新页面（桌面端 `Ctrl+R`，或彻底退出重开）。插件管理页里会显示「划选引用与批注」。

> 安装/更新时如果用的是本地目录软链，注意：Windows 上目录 junction 跨盘/含中文路径时 pnpm 可能报
> `UNKNOWN: unknown error`，此时改用 tarball 方式安装即可。

- 卸载：`plugin_manager` → `remove_bundle` → `dsh-quote-annotate`
- 禁用：`plugin_manager` → `set_bundle` → `enabled: false`

## 已知限制

- **不给输入框自动聚焦**：宿主没有公开的「聚焦并保留光标」seam，保存批注后需要自己点一下输入框再打字。
- 角标 / 高亮依赖 Transcript 的 `data-chat-flow-key` / `data-chat-turn` 属性；将来宿主改 DOM 约定时，
  高亮会退化为「只在批注条里可见」，但发送折叠不受影响（它只用文本）。
- 超长引用：发送时每条原文截断到 1200 字；批注列表里保留全文。
- 发送折叠靠捕获阶段的 Enter / 按钮识别；如果将来宿主改了按钮结构，Enter 路径仍然有效，
  另外批注条上的「插入正文」是永远可用的手动兜底。
- 仅 Web / 桌面端 Web UI，不支持 TUI。
- 插件更新后如果批注条消失或发送没带批注：**彻底退出并重开**一次（宿主热更新偶尔会留下半挂载的 bundle）。

## 许可证

MIT © 2026 HansHuang2683
- 仅 Web / 桌面端 Web UI，不支持 TUI。
