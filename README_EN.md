# dsh-browser-use

🧭 Built-in browser plugin for [dsh (DeepSeek Harness)](https://deepseek.com) — gives AI sessions a **real, controllable browser**, entirely on your local machine.

## Features

- **Autonomous browsing for the AI**: navigate, read, click, type and scroll with no manual steps
- **Screenshots straight into the chat**: AI screenshots are embedded inline in the conversation; click to view the full-size original
- **Built-in browser pane**: a right-docked live view of the page — click, scroll and type directly in the pane
- **Isolated & safe**: runs as Guest — no account sign-in, nothing syncs with your daily browser

## Install

Requirements: `dsh` installed; Microsoft Edge or Google Chrome on the machine.

```bash
dsh plugin --profile web add npm:dsh-browser-use
```

**Fully restart dsh** after installing (plugins load at startup; refreshing the page is not enough).

## Uninstall

```bash
dsh plugin --profile web remove dsh-browser-use
```

Then **fully restart dsh**. To also wipe browsing data, delete `~/.dsh/browser-use/` (contains the isolated profile, cache and screenshots).
