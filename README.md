# dsh-browser-use

简体中文 | [English](README_EN.md)

🧭 给 [dsh（DeepSeek Harness）](https://deepseek.com) 的内置浏览器插件 —— 让 AI 拥有一个真实可控的浏览器，全程在本机完成。

## 功能

- **AI 自主上网**：打开网页、读取内容、点击、输入、滚动，无需人工干预
- **截图直达对话**：AI 截图自动内嵌显示在对话消息流中，点击可查看原图
- **内置浏览器面板**：对话右侧停靠的实时画面，可直接点击、滚动、输入
- **隔离安全**：游客身份运行，不登录账号、不与日常浏览器同步数据

## 安装

前置要求：已安装 dsh；本机装有 Microsoft Edge 或 Google Chrome。

```bash
dsh plugin --profile web add npm:dsh-browser-use
```

安装后**彻底重启 dsh**（插件在 dsh 启动时加载，仅刷新页面不生效）。

## 卸载

```bash
dsh plugin --profile web remove dsh-browser-use
```

然后**彻底重启 dsh** 即可生效。如需一并清理浏览数据，删除目录 `~/.dsh/browser-use/`（内含独立 profile、缓存与截图）。

---

*社区第三方插件，与 DeepSeek 官方无隶属关系；dsh 及相关名称归其各自所有者。*
