# Image Upload RCGUI

**Paste an image into an Obsidian note and it lands on your own rclone remote** — the plugin talks to the local HTTP service of the RCGUI `imagehost` plugin, uploads the bytes, and rewrites the local link into the hosted URL.

English | [简体中文](README.zh-CN.md)

Obsidian normally saves a pasted image into the vault and inserts `![[attachment.png]]`. This plugin lets that happen, then swaps the fresh reference for `![|300x200](https://…)` — a hosted image, sized for the note. Nothing leaves your machine except the upload to your own remote; there is no third-party image host in the path.

- Repositories: [RCGUI](https://github.com/h897105167/rclone_gui_windows) · [imagehost plugin](https://github.com/h897105167/rcgui-plugin-imagehost)
- Plugin id `image-upload-rcgui`, version 1.2.0, requires Obsidian 1.4.0 or newer.

## Requirements

| Piece | Where |
| --- | --- |
| RCGUI desktop app, running | <https://github.com/h897105167/rclone_gui_windows> |
| `imagehost` plugin with its HTTP service on | <https://github.com/h897105167/rcgui-plugin-imagehost> (bundled with RCGUI) |

RCGUI owns the port; the default is `5273` and the app warns you when that port is taken. The device running Obsidian must be able to reach it — `127.0.0.1` for the same machine, or the full address in `服务地址` when Obsidian runs elsewhere.

## Install

This repository is the distribution: copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/image-upload-rcgui/`, then enable **Image Upload RCGUI** in Obsidian's community plugin list.

```text
.obsidian/plugins/image-upload-rcgui/
  manifest.json
  main.js
```

Then open the plugin's settings once and press **自动检测** — it pings the configured port, falls back to `5273`, and finally scans `5270–5285`, so a host on a non-default port is usually found without typing anything.

## Settings

Nothing takes effect until you press **保存**; the tab edits a draft copy, and **恢复默认** throws the draft away.

| Setting | Default | What it does |
| --- | --- | --- |
| `RCGUI 端口` | `5273` | Port of the host's HTTP service, with a **自动检测** button beside it. |
| `服务地址（可留空）` | empty | Wins over the port when set, e.g. `http://192.168.1.10:5273`. |
| `最大宽度` | `300` | Display width in the note; `0` means unlimited. |
| `最大高度` | `300` | Display height; together with the width it forms one box, scaled proportionally. |
| `上传前真的缩小图片` | off | Off: original pixels go up, only the display size is limited. On: re-encode the file itself to the limits above. |
| `粘贴时自动上传` | on | Off: pasted images stay local; upload them from the menu or the commands. |
| `上传后删除本地文件` | on | Vault images only, and it goes to the trash, so it is recoverable. |
| `插入哪种链接` | `直链` | `短链` needs the short-link template working on the RCGUI side; failures fall back to the direct link. |
| `内链换外链` | on | Also rewrite `![[img.png]]` into a plain hosted URL instead of leaving the wiki link. |

## Everyday use

- **Paste or drop an image.** The upload starts by itself; the status bar shows elapsed seconds, and reminders arrive at 60, 180 and 360 seconds so a slow upload never looks frozen.
- **Right-click a file** in the file explorer: **上传图片** uploads it and copies the link. Every reference to that file in the open note is rewritten, and the notice tells you how many.
- **Right-click inside a note**: **上传图片** on an image reference, **上传图片（选中内容里的图片）** on a selection that contains one.
- **Command palette** (names are Chinese): `上传剪贴板里的图片`, `检测 RCGUI 服务`, `上传当前笔记里选中的图片引用`.
- **Status bar** shows `● RCGUI 图床：就绪`, `◌` while detecting or uploading, `○` when the service is not there.

Uploads run one at a time on purpose: the plugin queues them behind each other, because three parallel requests made one of them take 28 seconds against a local host.

## What the note gets

`![|300x200](https://…)` — the numbers only change how large the image is drawn. Both axes come from one shared scale factor, so the aspect ratio survives; an image that already fits gets no suffix at all.

- An author-supplied size wins: `![[a.png|400]]` becomes `![|400](https://…)` rather than being resized to the configured box.
- Captions survive: `![shot](a.png)` becomes `![shot|300x200](https://…)`.
- An empty folder, a `#anchor`, or `%20` in the path resolves like Obsidian does, because the link is resolved through the metadata cache, not string surgery.
- Choose `短链` and the note gets the short URL when the host produced one; when it did not, a notice says why and the direct link is used.

## Talking to RCGUI

| Route | Direction | Notes |
| --- | --- | --- |
| `GET /plugin/imagehost/ping` | plugin → host | Probe only: it accepts the answer when `plugin` is `imagehost`, so a different server on that port is rejected. |
| `POST /plugin/imagehost/upload?name=…` | plugin → host | Raw image bytes as the body; no multipart, because the host caps multipart field sizes. |
| Upload response | host → plugin | `url`, `short_url`, `compressed`, `deduped`, `short_error` drive the notice and the link choice. |

Timeouts are deliberate: 2.5 s for the probe, 10 minutes for an upload. A local host pushes to the remote at roughly 75 KB/s, so a 20 MB screenshot needs minutes — a two-minute cap used to abort uploads that were still moving.

## Troubleshooting

- **没找到 RCGUI 的 HTTP 服务** — RCGUI is not running, or its HTTP service is off, or the port moved. Turn the service on in RCGUI's settings, then press 自动检测.
- **端口上跑的不是 imagehost 插件** — something else answered on that port. Check the port number, or what RCGUI says it is serving.
- **上传超时：等了 600 秒服务端还没回** — the image is probably already on its way; look in RCGUI's imagehost panel before pasting again. Pasting the same file again returns the existing link instead of uploading a second copy.
- **HTTP 413** — the file is over the host's size limit (`体积上限`, 20 MB by default). Raise the limit in RCGUI's imagehost panel, or turn on `上传前真的缩小图片` so the file is re-encoded before it goes up.
- **短链没成** — the short-link template is not configured on the host. The direct link is used in the meantime.
- **图片已上传，但删除本地文件失败了** — Obsidian refused the trash call; the link is fine, delete the attachment by hand.

## Building

```bash
npm install
npm run build      # esbuild -> main.js
npm run dev        # rebuild on change
```

`main.js` is the only artifact Obsidian loads besides `manifest.json`; `src/` is TypeScript and is not shipped. Reload the plugin in Obsidian after a rebuild.

## Known limits

- Design assumes one vault owner: settings are per vault, and uploads are not attributed to anyone.
- The link only works while the host can serve it — the direct link points at your remote, the proxy form at a running RCGUI.
- `上传后删除本地文件` can only send vault files to the trash; files outside the vault are not touched.
- Animated GIFs are never re-encoded, so they upload at full size and can hit the host limit.
- The plugin has no `styles.css`; the status bar and notices are plain Obsidian UI.
