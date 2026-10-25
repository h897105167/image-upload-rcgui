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
const EMBED = /!\[\[([^\]|]+)(\|[^\]]*)?\]\]/;

export default class ImageUploadRcgui extends Plugin {
	settings: RcguiSettings = { ...DEFAULT_SETTINGS };
	private statusEl: HTMLElement | null = null;
	private busy = 0;

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
							.onClick(() => void this.uploadEmbed(target.file, target.match, editor, info)),
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
				await this.uploadEmbed(target.file, target.match, editor, view);
			},
		});

		// Light probe at startup, only for the status bar; never bothers the user.
		void this.detectService(false);
	}

	onunload(): void {
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
				const url = await this.send(file, stampName(file));
				const snippet = `![](${url})`;
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
				await this.uploadEmbed(hit.file, hit.match, editor, info, hit.line);
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
	): { file: TFile; match: RegExpMatchArray; line: number } | null {
		const notePath = info.file?.path ?? '';
		for (const at of [line, line + 1]) {
			if (at < 0 || at >= editor.lineCount()) continue;
			const match = editor.getLine(at).match(EMBED);
			if (!match) continue;
			const dest = this.app.metadataCache.getFirstLinkpathDest(match[1].trim(), notePath);
			if (!dest) continue;
			return { file: dest, match, line: at };
		}
		return null;
	}

	private async uploadEmbed(
		file: TFile,
		match: RegExpMatchArray,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
		line?: number,
	): Promise<void> {
		const notePath = info.file?.path ?? '';
		const linkText = match[1].trim();
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkText, notePath);
		const target = dest ?? file;
		try {
			const buf = await this.app.vault.readBinary(target);
			const blob = new Blob([buf], { type: this.mimeOf(target) });
			const url = await this.send(blob, target.name);
			if (this.settings.replaceEmbeds) {
				const replacement = `![](${url})`;
				const at = line ?? editor.getCursor().line;
				const lineText = editor.getLine(at);
				const next = lineText.replace(match[0], replacement);
				if (next !== lineText) editor.setLine(at, next);
			} else {
				new Notice(`已上传：${url}`, 8000);
			}
			if (this.settings.deleteLocalFile) await this.trash(target);
		} catch (e) {
			this.fail(e);
		}
	}

	private async uploadSelection(editor: Editor, info: MarkdownView | MarkdownFileInfo): Promise<void> {
		const text = editor.getSelection();
		const match = text.match(EMBED) ?? editor.getLine(editor.getCursor().line).match(EMBED);
		if (!match) {
			new Notice('没在选中内容里找到图片引用');
			return;
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(
			match[1].trim(),
			info.file?.path ?? '',
		);
		if (!dest) {
			new Notice(`找不到图片：${match[1]}`);
			return;
		}
		await this.uploadEmbed(dest, match, editor, info);
	}

	private async uploadVaultFile(file: TFile): Promise<void> {
		try {
			const buf = await this.app.vault.readBinary(file);
			const blob = new Blob([buf], { type: this.mimeOf(file) });
			const url = await this.send(blob, file.name);
			await navigator.clipboard.writeText(url).catch(() => undefined);
			new Notice(`已上传并复制链接：${url}`, 8000);
			if (this.settings.deleteLocalFile) await this.trash(file);
		} catch (e) {
			this.fail(e);
		}
	}

	/** One full upload: shrink -> upload -> the URL to insert. */
	private async send(blob: Blob, name: string): Promise<string> {
		this.begin();
		try {
			const prepared = await prepareImage(blob, name, this.settings.maxWidth, this.settings.maxHeight);
			const res = await this.client().upload(prepared.blob, prepared.filename);
			const shortOk = this.settings.linkKind === 'short' && !!res.short_url;
			if (this.settings.linkKind === 'short' && !res.short_url && res.short_error) {
				new Notice(`短链没成（${res.short_error}），先用直链`, 6000);
			}
			const url = shortOk ? (res.short_url as string) : res.url;
			this.renderStatus('就绪');
			const bits: string[] = [];
			if (res.compressed) bits.push(`压缩 ${fmtSize(res.original_size)} → ${fmtSize(res.size)}`);
			if (res.deduped) bits.push('命中已有文件');
			if (prepared.resized && !res.compressed) bits.push(`缩到 ${prepared.width}×${prepared.height}`);
			new Notice(`上传成功${bits.length ? `（${bits.join('，')}）` : ''}`, 4000);
			return url;
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
	): { file: TFile; match: RegExpMatchArray } | null {
		const line = editor.getLine(editor.getCursor().line);
		const match = line.match(EMBED);
		if (!match) return null;
		const dest = this.app.metadataCache.getFirstLinkpathDest(match[1].trim(), info.file?.path ?? '');
		if (!dest) return null;
		return { file: dest, match };
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
		this.renderStatus('上传中…');
	}

	private end(): void {
		this.busy = Math.max(0, this.busy - 1);
		if (this.busy === 0) this.renderStatus('就绪');
	}

	private renderStatus(text: string): void {
		if (!this.statusEl) return;
		const dot = text === '就绪' ? '●' : text === '未连接' ? '○' : '◌';
		this.statusEl.setText(`${dot} RCGUI 图床：${text}`);
	}

	private fail(e: unknown): void {
		const msg = e instanceof UploadError || e instanceof Error ? e.message : String(e);
		console.error('[image-upload-rcgui]', e);
		new Notice(msg, 8000);
		if (msg.includes('没找到 RCGUI') || msg.includes('超时')) this.renderStatus('未连接');
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
