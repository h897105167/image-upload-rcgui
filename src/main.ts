import {
	Editor,
	EditorPosition,
	MarkdownFileInfo,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { embedMarkdown, Fit, fitForDisplay } from './embed';
import { RcguiSettingTab } from './settings';
import { DEFAULT_SETTINGS, RcguiSettings } from './types';
import {
	imagesFrom,
	prepareImage,
	RcguiClient,
	stampName,
	UploadError,
} from './uploader';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
/** Wiki embed: `![[a.png]]` or `![[a.png|300]]`. */
const EMBED = /!\[\[([^\]|]+)(\|[^\]]*)?\]\]/;
/** Markdown image: `![](a.png)`, `![alt](<a b.png>)`, `![alt](a.png "title")`. */
const MD_IMAGE = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(\s+"[^"]*")?\)/g;
/** Same as {@link EMBED}, global, for rewriting every occurrence on a line. */
const EMBED_G = /!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;
/** Which flavour of image reference a match came from. */
type EmbedKind = 'wiki' | 'md';

export default class ImageUploadRcgui extends Plugin {
	settings: RcguiSettings = { ...DEFAULT_SETTINGS };
	private statusEl: HTMLElement | null = null;
	private busy = 0;
	private ticker: number | null = null;
	private startedAt = 0;
	private said60 = false;
	private said180 = false;
	private said360 = false;
	/** Uploads run one at a time: the site queues them anyway, and 3 parallel requests made one take 28 s. */
	private chain: Promise<unknown> = Promise.resolve();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new RcguiSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.renderStatus('未检测');

		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor, info) => {
				if (!this.settings.autoUploadOnPaste) return;
				if (imagesFrom(evt.clipboardData).length === 0) return;
				// Do not preventDefault: let Obsidian store the image as a vault attachment first,
				// then swap that local link for the uploaded one; that file is what gets deleted.
				const from: EditorPosition = editor.getCursor();
				void this.followPastedAttachment(editor, info, from);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-drop', (evt: DragEvent, editor: Editor, info) => {
				if (!this.settings.autoUploadOnPaste) return;
				if (imagesFrom(evt.dataTransfer).length === 0) return;
				const from: EditorPosition = editor.getCursor();
				void this.followPastedAttachment(editor, info, from);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const target = this.embedAtCursor(editor, info);
				if (target) {
					menu.addItem((item) =>
						item
							.setTitle('上传图片')
							.setIcon('upload')
							.onClick(() =>
								void this.uploadEmbed(target.file, target.match, target.kind, editor, info),
							),
					);
					return;
				}
				if (editor.getSelection().trim()) {
					menu.addItem((item) =>
						item
							.setTitle('上传图片（选中内容里的图片）')
							.setIcon('upload')
							.onClick(() => void this.uploadSelection(editor, info)),
					);
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) || !IMAGE_EXT.test(file.name)) return;
				menu.addItem((item) =>
					item
						.setTitle('上传图片')
						.setIcon('upload')
						.onClick(() => void this.uploadVaultFile(file)),
				);
			}),
		);

		this.addCommand({
			id: 'upload-clipboard-image',
			name: '上传剪贴板里的图片',
			editorCallback: async (editor: Editor) => {
				const blobs = await this.readClipboardImages();
				if (blobs.length === 0) {
					new Notice('剪贴板里没有图片');
					return;
				}
				await this.handlePastedImages(blobs, editor, editor.getCursor());
			},
		});

		this.addCommand({
			id: 'detect-service',
			name: '检测 RCGUI 服务',
			callback: () => void this.detectService(true),
		});

		this.addCommand({
			id: 'upload-active-file-image',
			name: '上传当前笔记里选中的图片引用',
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const target = this.embedAtCursor(editor, view);
				if (!target) {
					new Notice('光标没落在一个图片内链上');
					return;
				}
				await this.uploadEmbed(target.file, target.match, target.kind, editor, view);
			},
		});

		// Light probe at startup, only for the status bar; never bothers the user.
		void this.detectService(false);
	}

	onunload(): void {
		this.stopTicker();
		this.statusEl = null;
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<RcguiSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
	}

	async saveSettings(next: RcguiSettings): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...next };
		await this.saveData(this.settings);
	}

	async resetSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS };
		await this.saveData(this.settings);
	}

	client(settings?: RcguiSettings): RcguiClient {
		return new RcguiClient(settings ?? this.settings);
	}

	// ---------- upload flow ----------

	private async handlePastedImages(files: File[], editor: Editor, from: EditorPosition): Promise<void> {
		let cursor = from;
		for (const file of files) {
			try {
				const sent = await this.send(file, stampName(file));
				const snippet = embedMarkdown(sent.url, sent.fit);
				editor.replaceRange(snippet, cursor);
				cursor = editor.offsetToPos(editor.posToOffset(cursor) + snippet.length);
			} catch (e) {
				this.fail(e);
				return;
			}
		}
	}

	/**
	 * Tracking after paste/drop: Obsidian first stores the clipboard image as a vault attachment and inserts `![[...]]`.
	 * Watch for a fresh attachment reference near the cursor and replace it with the hosted URL.
	 * Only files just written into the vault (fresh mtime) are touched; network URLs never are.
	 */
	private async followPastedAttachment(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
		from: EditorPosition,
	): Promise<void> {
		const deadline = Date.now() + 6000;
		let handled = 0;
		while (Date.now() < deadline && handled < 8) {
			const hit = this.embedNear(editor, info, from.line);
			if (hit && hit.file.stat.mtime >= Date.now() - 15000) {
				handled += 1;
				await this.uploadEmbed(hit.file, hit.match, hit.kind, editor, info, hit.line);
				continue;
			}
			await sleep(hit ? 80 : 150);
		}
	}

	/** Image embed near the cursor (current or next line). */
	private embedNear(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
		line: number,
	): { file: TFile; match: RegExpMatchArray; kind: EmbedKind; line: number } | null {
		const notePath = info.file?.path ?? '';
		for (const at of [line, line + 1]) {
			if (at < 0 || at >= editor.lineCount()) continue;
			const hit = this.matchRef(editor.getLine(at), notePath);
			if (!hit) continue;
			return { ...hit, line: at };
		}
		return null;
	}

	private async uploadEmbed(
		file: TFile,
		match: RegExpMatchArray,
		kind: EmbedKind,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
		line?: number,
	): Promise<void> {
		const notePath = info.file?.path ?? '';
		const target = this.resolveLinkpath(match[1], notePath) ?? file;
		try {
			const buf = await this.app.vault.readBinary(target);
			const blob = new Blob([buf], { type: this.mimeOf(target) });
			const sent = await this.send(blob, target.name);
			const at = line ?? editor.getCursor().line;
			if (this.settings.replaceEmbeds) {
				const lineText = editor.getLine(at);
				const next = lineText.replace(match[0], this.replacementFor(kind, match, sent.url, sent.fit));
				if (next !== lineText) {
					editor.setLine(at, next);
				} else {
					// Nothing was swapped: say why instead of silently leaving the old path behind.
					new Notice(`已上传，但第 ${at + 1} 行没找到这段引用，链接已复制：${sent.url}`, 10000);
					await navigator.clipboard.writeText(sent.url).catch(() => undefined);
				}
			} else {
				new Notice(`已上传：${sent.url}`, 8000);
			}
			if (this.settings.deleteLocalFile) await this.trash(target);
		} catch (e) {
			this.fail(e);
		}
	}

	private async uploadSelection(editor: Editor, info: MarkdownView | MarkdownFileInfo): Promise<void> {
		const notePath = info.file?.path ?? '';
		const text = editor.getSelection() || editor.getLine(editor.getCursor().line);
		const hit = this.matchRef(text, notePath);
		if (!hit) {
			new Notice('没在选中内容里找到图片引用');
			return;
		}
		await this.uploadEmbed(hit.file, hit.match, hit.kind, editor, info);
	}

	private async uploadVaultFile(file: TFile): Promise<void> {
		try {
			const buf = await this.app.vault.readBinary(file);
			const blob = new Blob([buf], { type: this.mimeOf(file) });
			const sent = await this.send(blob, file.name);
			await navigator.clipboard.writeText(sent.url).catch(() => undefined);
			// A file picked in the explorer has no cursor, so rewrite every reference to it in the open note.
			const swapped = this.settings.replaceEmbeds
				? this.replaceReferencesInActiveNote(file, sent.url, sent.fit)
				: 0;
			new Notice(
				swapped > 0
					? `已上传，替换了当前笔记里 ${swapped} 处引用：${sent.url}`
					: `已上传并复制链接（当前笔记里没有引用它）：${sent.url}`,
				8000,
			);
			if (this.settings.deleteLocalFile) await this.trash(file);
		} catch (e) {
			this.fail(e);
		}
	}

	/** Queue the upload behind whatever is still running, then hand it to `sendNow`. */
	private send(blob: Blob, name: string): Promise<{ url: string; fit: Fit }> {
		const run = () => this.sendNow(blob, name);
		const next = this.chain.then(run, run);
		this.chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** One full upload: (optional) shrink -> upload -> URL + the display size for the note. */
	private async sendNow(blob: Blob, name: string): Promise<{ url: string; fit: Fit }> {
		this.begin();
		try {
			const prepared = await prepareImage(
				blob,
				name,
				this.settings.maxWidth,
				this.settings.maxHeight,
				this.settings.shrinkPixels,
			);
			const res = await this.client().upload(prepared.blob, prepared.filename);
			const shortOk = this.settings.linkKind === 'short' && !!res.short_url;
			if (this.settings.linkKind === 'short' && !res.short_url && res.short_error) {
				new Notice(`短链没成（${res.short_error}），先用直链`, 6000);
			}
			const url = shortOk ? (res.short_url as string) : res.url;
			const fit = fitForDisplay(
				prepared.width,
				prepared.height,
				this.settings.maxWidth,
				this.settings.maxHeight,
			);
			this.renderStatus('就绪');
			const bits: string[] = [];
			if (res.compressed) bits.push(`压缩 ${fmtSize(res.original_size)} → ${fmtSize(res.size)}`);
			if (res.deduped) bits.push('命中已有文件');
			if (prepared.resized && !res.compressed) bits.push(`缩到 ${prepared.width}×${prepared.height}`);
			if (fit.scaled) bits.push(`显示 ${fit.width}×${fit.height}`);
			new Notice(`上传成功${bits.length ? `（${bits.join('，')}）` : ''}`, 4000);
			return { url, fit };
		} finally {
			this.end();
		}
	}

	private async trash(file: TFile): Promise<void> {
		try {
			const fm = this.app.fileManager as unknown as { trashFile?: (f: TFile) => Promise<void> };
			if (typeof fm.trashFile === 'function') await fm.trashFile(file);
			else await this.app.vault.delete(file);
		} catch {
			new Notice('图片已上传，但删除本地文件失败了', 5000);
		}
	}

	// ---------- helpers ----------

	private embedAtCursor(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
	): { file: TFile; match: RegExpMatchArray; kind: EmbedKind } | null {
		return this.matchRef(editor.getLine(editor.getCursor().line), info.file?.path ?? '');
	}

	/** First image reference in `text` that points at a real vault file (wiki embed or markdown image). */
	private matchRef(
		text: string,
		notePath: string,
	): { file: TFile; match: RegExpMatchArray; kind: EmbedKind } | null {
		const wiki = text.match(EMBED);
		if (wiki) {
			const dest = this.resolveLinkpath(wiki[1], notePath);
			if (dest) return { file: dest, match: wiki, kind: 'wiki' };
		}
		MD_IMAGE.lastIndex = 0;
		const md = MD_IMAGE.exec(text);
		if (md) {
			const dest = this.resolveLinkpath(md[2], notePath);
			if (dest) return { file: dest, match: md, kind: 'md' };
		}
		return null;
	}

	/**
	 * Resolve a link target to a vault file, accepting both the wiki form (`a.png`,
	 * `folder/a.png`) and markdown paths (`./a.png`, `<a b.png>`, `a%20b.png`, with
	 * an optional `#anchor`).
	 */
	private resolveLinkpath(linkpath: string, notePath: string): TFile | null {
		const raw = linkpath
			.trim()
			.replace(/^</, '')
			.replace(/>$/, '')
			.split('#')[0]
			.trim();
		if (!raw || /^[a-z]+:\/\//i.test(raw)) return null;
		let decoded = raw;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			decoded = raw;
		}
		const found = this.app.metadataCache.getFirstLinkpathDest(decoded, notePath);
		if (found) return found;
		const direct = this.app.vault.getAbstractFileByPath(decoded.replace(/^\.\//, ''));
		return direct instanceof TFile ? direct : null;
	}

	/** New markdown for a reference, keeping an author-supplied size or caption. */
	private replacementFor(
		kind: EmbedKind,
		match: RegExpMatchArray,
		url: string,
		fit: Fit,
	): string {
		if (kind === 'wiki') return embedMarkdown(url, fit, match[2] ?? '');
		return this.mdReplacement(match[1] ?? '', url, fit);
	}

	/** Markdown image -> hosted link; `![300](a.png)` carries a size where markdown expects a caption. */
	private mdReplacement(alt: string, url: string, fit: Fit): string {
		const caption = alt.trim();
		if (/^\|?\d+(x\d+)?$/.test(caption)) {
			return embedMarkdown(url, fit, caption.startsWith('|') ? caption : `|${caption}`);
		}
		return embedMarkdown(url, fit, '', caption);
	}

	/** Swap every reference to `file` in the active note; returns how many were swapped. */
	private replaceReferencesInActiveNote(file: TFile, url: string, fit: Fit): number {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) return 0;
		const editor = view.editor;
		const notePath = view.file?.path ?? '';
		let swapped = 0;
		for (let i = 0; i < editor.lineCount(); i += 1) {
			const line = editor.getLine(i);
			if (!line.includes('![')) continue;
			EMBED_G.lastIndex = 0;
			let next = line.replace(EMBED_G, (whole: string, lp: string, suffix?: string) => {
				if (this.resolveLinkpath(lp, notePath)?.path !== file.path) return whole;
				swapped += 1;
				return embedMarkdown(url, fit, suffix ?? '');
			});
			MD_IMAGE.lastIndex = 0;
			next = next.replace(MD_IMAGE, (whole: string, alt: string, dest: string) => {
				if (this.resolveLinkpath(dest, notePath)?.path !== file.path) return whole;
				swapped += 1;
				return this.mdReplacement(alt, url, fit);
			});
			if (next !== line) editor.setLine(i, next);
		}
		return swapped;
	}

	private mimeOf(file: TFile): string {
		const ext = file.extension.toLowerCase();
		if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
		if (ext === 'gif') return 'image/gif';
		if (ext === 'webp') return 'image/webp';
		if (ext === 'svg') return 'image/svg+xml';
		if (ext === 'bmp') return 'image/bmp';
		if (ext === 'avif') return 'image/avif';
		return 'image/png';
	}

	private async readClipboardImages(): Promise<File[]> {
		try {
			const items = await navigator.clipboard.read();
			const out: File[] = [];
			for (const item of items) {
				for (const type of item.types) {
					if (!type.startsWith('image/')) continue;
					const blob = await item.getType(type);
					const ext = type.split('/')[1] ?? 'png';
					out.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }));
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	private async detectService(verbose: boolean): Promise<void> {
		this.renderStatus('检测中…');
		try {
			const { info } = await this.client().detect();
			this.renderStatus('就绪');
			if (verbose) {
				new Notice(`RCGUI 图床就绪：端口 ${info.port}，上限 ${info.max_mb}MB`, 5000);
			}
		} catch (e) {
			this.renderStatus('未连接');
			if (verbose) this.fail(e);
		}
	}

	private begin(): void {
		this.busy += 1;
		this.startedAt = Date.now();
		this.said60 = false;
		this.said180 = false;
		this.said360 = false;
		this.stopTicker();
		this.ticker = window.setInterval(() => this.paintBusy(), 1000);
		this.paintBusy();
	}

	/** 「上传中… 12s」——让用户看见它还在动，而不是像卡死。 */
	private paintBusy(): void {
		const sec = Math.round((Date.now() - this.startedAt) / 1000);
		this.renderStatus(sec > 0 ? `上传中… ${sec}s` : '上传中…');
		if (sec >= 60 && !this.said60) {
			this.said60 = true;
			new Notice('图床服务还在处理（已 60 秒）：Telegram 那边偶尔会排队，继续等即可', 6000);
		} else if (sec >= 180 && !this.said180) {
			this.said180 = true;
			new Notice('已经 3 分钟了：大图走这条线路确实慢（约 75 KB/s），还在传就继续等', 8000);
		} else if (sec >= 360 && !this.said360) {
			this.said360 = true;
			new Notice('已经 6 分钟了：要么图很大，要么真卡住了。不想等就取消后重试小的', 9000);
		}
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			window.clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	private end(): void {
		this.busy = Math.max(0, this.busy - 1);
		if (this.busy === 0) {
			this.stopTicker();
			this.renderStatus('就绪');
		}
	}

	private renderStatus(text: string): void {
		if (!this.statusEl) return;
		const dot = text === '就绪' ? '●' : text === '未连接' ? '○' : '◌';
		this.statusEl.setText(`${dot} RCGUI 图床：${text}`);
	}

	private fail(e: unknown): void {
		const msg = e instanceof UploadError || e instanceof Error ? e.message : String(e);
		console.error('[image-upload-rcgui]', e);
		new Notice(msg, 10000);
		// 只有「服务根本不在」才标红；超时说明服务在，只是慢，别把状态骗成未连接。
		if (msg.includes('没找到 RCGUI')) this.renderStatus('未连接');
	}
}

function fmtSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
