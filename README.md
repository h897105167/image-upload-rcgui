# image-upload-rcgui

An Obsidian plugin that uploads images to the local HTTP service of the **RCGUI**
`imagehost` plugin and replaces the local image link with the returned URL.

Paste an image into a note and it is uploaded, resized if needed, and the
`![[attachment.png]]` link is rewritten into a direct (or short) link.

## Requirements

| Piece | Where |
| --- | --- |
| RCGUI desktop app | <https://github.com/h897105167/rclone_gui_windows> |
| RCGUI `imagehost` plugin (v0.6.0+, provides the HTTP upload service) | <https://github.com/h897105167/rcgui-plugin-imagehost> |

RCGUI must be running with the `imagehost` plugin installed and its plugin HTTP
service reachable (default port `5273`). The service was added in `imagehost`
v0.6.0 — if the released build you have is older, build the plugin from the
repository above. The app owns the port setting and shows a warning when the
port is already taken.
This plugin never talks to GitHub, rclone, or the image host directly: it only
calls the service on `127.0.0.1`.

## Install

### From a release (recommended)

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/h897105167/image-upload-rcgui/releases/latest).
2. Put both files in `<vault>/.obsidian/plugins/image-upload-rcgui/`.
3. Enable **Image Upload RCGUI** in Settings → Community plugins.

[BRAT](https://github.com/TfTHacker/obsidian42-brat) can also install it from the
repository URL.

### From source

```bash
npm install
npm run build
npm run typecheck
```

`main.js` is committed, so a plain checkout is installable without a build.

## Settings

| Field | Meaning |
| --- | --- |
| RCGUI HTTP port | Port of the imagehost plugin HTTP service (default `5273`). |
| Auto-detect | Probes the port, then a small range around it, and saves the port that answers `/plugin/imagehost/ping`. |
| Server URL | Optional. Full base URL; wins over the port when set (remote host / port forward). |
| Max width / height | Pixels. Oversized images are scaled down proportionally (default 300 × 300). `0` = no limit. |
| Upload on paste | Pasted / dropped images are uploaded, and the local `![[...]]` link is replaced with the returned URL. Network URLs are never touched. |
| Delete local file | After a successful upload, the local attachment is moved to the trash. Default on; turn it off to keep the file. |
| Link kind | `direct` or `short`. Short falls back to the direct link when the server cannot shorten it. |
| Replace embeds | Replace `![[img.png]]` with `![](url)`; when off the URL is only shown in a notice / copied to the clipboard. |

The **Save** button persists settings to the plugin's `data.json`; **Restore
defaults** resets them.

## Usage

- Paste or drag an image into a note (requires *Upload on paste*).
- Right-click in a note → **Upload image** (uploads the image embed under the
  cursor, or the image referenced by the selection).
- Right-click a vault image file → **Upload image** (uploads it and copies the URL).
- Commands: *Upload image from clipboard*, *Detect RCGUI service*,
  *Upload image embed at cursor*.

Server-side behaviour comes from the RCGUI `imagehost` plugin: size limit
(default 20 MB, over-limit images are compressed before upload), dedupe of
identical files, and optional short links.

## HTTP contract used

- `GET  <base>/plugin/imagehost/ping` → `{ok, version, port, max_mb, compress, short, remote, dir, upload_url}`
- `POST <base>/plugin/imagehost/upload?name=<file>` with the raw image bytes as
  the body and the image MIME type as `Content-Type`
  → `{ok, url, short_url, name, stored, size, original_size, compressed, deduped, short_error?}`

Multipart is accepted by the server as well, but keep those requests under ~2 MB;
larger bodies should be sent as raw bytes.

## Troubleshooting

- *Cannot find the RCGUI HTTP service*: start RCGUI, enable the plugin HTTP
  service, check the port in the imagehost panel, press **Auto-detect**.
- Upload returns 413 with a decode error: the image exceeds the server limit and
  could not be compressed; raise the limit in the imagehost panel.

## License

MIT — see [LICENSE](LICENSE).
