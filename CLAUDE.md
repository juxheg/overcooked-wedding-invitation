# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指引。

## 项目简介

一个为手机端设计的《胡闹厨房》风格互动婚礼邀请函模板，简体中文内容。纯静态 HTML/CSS/JS——没有 package.json、没有构建步骤、没有任何依赖。以公开模板形式发布；预期的定制入口只有一个文件：`public/config.js`。

## 常用命令

```bash
# 预览：无需服务器，直接打开即可（file:// 协议可用）
open public/index.html

# 静态结构审计——修改 HTML/config/app.js 后运行。
# 检查重复 id、违反 CSP 的内联事件处理器、缺失的本地资源，
# 以及 app.js 的选择器回归守卫。
python3 scripts/check_static.py

# 从 public/assets/ 中的源 jpg/png 重新生成 webp 衍生图（需要 Pillow 和 raw-sources 原图）
python3 scripts/optimize_assets.py
```

仓库没有测试和 linter。仓库自带的 QA 清单（来自 AI_SETUP_PROMPT.md）：在 **375px、390px、430px** 宽度下检查——首页、订单卡、小游戏（开始 / 计时 / 得分 / 扣时间 / 结束 / 再玩一次）、厨房来电、菜单、地图、登记表；不得出现文字溢出或横向滚动。

## 架构

页面完全位于 `public/` 内。根目录 `index.html` 只是跳转到 `./public/` 的重定向页（GitHub Pages 从仓库根目录部署）。`raw-sources/` 存放未压缩的原始图片，页面不使用。

**配置驱动渲染。** `public/config.js` 定义 `window.WEDDING_INVITATION`——所有用户可编辑内容。`app.js` 中的运行时契约：

- 带 `data-field="key"` 的元素从配置取值写入 `textContent`（仅接受字符串）
- 带 `data-link="key"` 的元素写入 `href`，且仅当值匹配 `/^https?:\/\//` 时生效
- 数组型配置（`schedule`、`crewMessages`、`gameRecipes`、`gameBlessings`、`gameRewards`）由对应的 `render*` 函数渲染进 DOM

**app.js 结构。** 单个 IIFE；各功能为独立函数（`bindConfig`、`initGame`、`renderCrew`、`bindRSVP` 等），由 `steps` 数组按顺序执行，每步单独 try/catch，因此单个功能出错不会阻塞其余功能。新增功能时保持这一模式。

**CSP 很严格**（见 `public/_headers`）：`script-src 'self'; style-src 'self'`——任何地方都不允许内联 `<script>`、内联 `style` 或 `on*` 事件属性。图片回退使用 `data-fallback-src` 属性 + `error` 事件监听（webp → png/jpg），绝不用内联 `onerror`。出现内联事件处理器时 `check_static.py` 会直接报错。

**localStorage 键名**（全部包在 try/catch 里—— Safari 无痕模式会抛异常）：`oc_wedding_rsvp`（表单数据）、`oc_wedding_best`（游戏最高分）、`oc_wedding_last`（最近一局结果）。

**缓存刷新。** `style.css`、`app.js`、`config.js` 在 `public/index.html` 中以 `?v=YYYYMMDD-…` 查询串加载——修改这些文件时必须同步更新版本号，否则访客会看到旧缓存。

## 硬性约束

- **RSVP 仅为本机演示，这是设计决定。** 宾客数据只保存在访客自己的浏览器 localStorage 中。绝不添加上传服务器、提交第三方、管理后台或导出功能——这一承诺在 README/GUIDE/AI_SETUP_PROMPT 中反复声明，是模板的隐私契约。
- **所有用户可编辑文案集中在 `config.js`。** 定制时不要把个性化文字散落到 HTML/CSS/JS。例外：`public/index.html` 中的 `<title>`、Open Graph / Twitter meta 标签和首屏回退文案是硬编码的，定制时必须与配置同步修改（它们为爬虫/微信分享复制了配置内容）。
- **`dateTime` 必须保持带时区偏移的 ISO 8601 格式**（`2030-10-01T18:30:00+08:00`）——倒计时用 `new Date()` 解析它。
- **素材版权：** 代码采用 MIT，但 `public/assets/` 中的胡闹厨房游戏美术/音乐**不在** MIT 授权范围内，不可再分发。不要新增第三方素材；用原创或已授权素材替换是文档中明确建议的做法（见 COPYRIGHT_NOTICE.md、THIRD_PARTY_ASSETS.md）。
- `style.css` 的设计约定：设计 token 是 `:root` 中的 CSS 自定义属性；中文大字遵循三层 `text-shadow` 铁律（禁用 `-webkit-text-stroke`）；内容限制在 480px 宽的「手机外壳」内；`prefers-reduced-motion` 下禁用所有动画。
