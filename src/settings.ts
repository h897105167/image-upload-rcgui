import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ImageUploadRcgui from './main';
import { RcguiSettings } from './types';

export class RcguiSettingTab extends PluginSettingTab {
	private draft: RcguiSettings;
	private detectMsg = '';

	constructor(
		app: App,
		private readonly plugin: ImageUploadRcgui,
	) {
		super(app, plugin);
		this.draft = { ...plugin.settings };
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.draft = { ...this.plugin.settings };

		containerEl.createEl('h2', { text: 'Image Upload RCGUI' });
		containerEl.createEl('p', {
			text: '图片走 RCGUI 的图床插件（imagehost）上传：宿主的 HTTP 服务负责收字节，插件负责存远程、回直链和短链。改完记得按「保存」。',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('RCGUI 端口')
			.setDesc('RCGUI 设置里 HTTP 服务的端口，默认 5273。')
			.addText((text) =>
				text
					.setPlaceholder('5273')
					.setValue(String(this.draft.port || ''))
					.onChange((v) => {
						const n = Number(v.trim());
						this.draft.port = Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : 5273;
					}),
			)
			.addButton((btn) =>
				btn.setButtonText('自动检测').onClick(async () => {
					btn.setDisabled(true).setButtonText('检测中…');
					try {
						const { port, info } = await this.plugin.client(this.draft).detect();
						if (port !== null) this.draft.port = port;
						this.detectMsg = `已连上 ${info.version}（端口 ${info.port}，上限 ${info.max_mb}MB，压缩${info.compress ? '开' : '关'}，短链${info.short ? '开' : '关'}）`;
						new Notice(`RCGUI 图床已就绪：${info.port}`);
					} catch (e) {
						this.detectMsg = e instanceof Error ? e.message : String(e);
						new Notice(this.detectMsg, 8000);
					} finally {
						btn.setDisabled(false).setButtonText('自动检测');
						this.display();
					}
				}),
			);

		new Setting(containerEl)
			.setName('服务地址（可留空）')
			.setDesc('填了就用它，例如 http://192.168.1.10:5273；留空则用 127.0.0.1 + 上面的端口。')
			.addText((text) =>
				text
					.setPlaceholder('http://127.0.0.1:5273')
					.setValue(this.draft.serverUrl)
					.onChange((v) => {
						this.draft.serverUrl = v.trim();
					}),
			);

		if (this.detectMsg) {
			const box = containerEl.createDiv({ cls: 'rcgui-detect-msg' });
			box.setText(`检测结果：${this.detectMsg}`);
		}

		new Setting(containerEl)
			.setName('最大宽度')
			.setDesc('笔记里显示的最大宽度（嵌入语法 `![|宽x高](url)`），超出按比例缩到框内；0 表示不限制。')
			.addText((text) =>
				text
					.setPlaceholder('300')
					.setValue(String(this.draft.maxWidth))
					.onChange((v) => {
						const n = Number(v.trim());
						this.draft.maxWidth = Number.isFinite(n) && n >= 0 ? Math.round(n) : 300;
					}),
			);

		new Setting(containerEl)
			.setName('最大高度')
			.setDesc('同上，两个值共同决定显示框；等比缩放，不会变形。')
			.addText((text) =>
				text
					.setPlaceholder('300')
					.setValue(String(this.draft.maxHeight))
					.onChange((v) => {
						const n = Number(v.trim());
						this.draft.maxHeight = Number.isFinite(n) && n >= 0 ? Math.round(n) : 300;
					}),
			);

		new Setting(containerEl)
			.setName('上传前真的缩小图片')
			.setDesc('默认关：原图照传，只在笔记里限制显示大小。打开后按上面的宽高重编码文件本身（会损失画质）。')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.shrinkPixels).onChange((v) => {
					this.draft.shrinkPixels = v;
				}),
			);

		new Setting(containerEl)
			.setName('粘贴时自动上传')
			.setDesc('关掉后粘贴图片仍然留在本地，只能用右键菜单或命令上传。')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.autoUploadOnPaste).onChange((v) => {
					this.draft.autoUploadOnPaste = v;
				}),
			);

		new Setting(containerEl)
			.setName('上传后删除本地文件')
			.setDesc('只对库里的图片文件生效（进回收站，可找回）。粘贴的临时文件不受影响。')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.deleteLocalFile).onChange((v) => {
					this.draft.deleteLocalFile = v;
				}),
			);

		new Setting(containerEl)
			.setName('插入哪种链接')
			.setDesc('短链需要 RCGUI 那边的短链服务可用；短链失败会自动退回直链。')
			.addDropdown((dd) =>
				dd
					.addOption('direct', '直链')
					.addOption('short', '短链')
					.setValue(this.draft.linkKind)
					.onChange((v) => {
						this.draft.linkKind = v === 'short' ? 'short' : 'direct';
					}),
			);

		new Setting(containerEl)
			.setName('内链换外链')
			.setDesc('对 `![[img.png]]` 执行「上传图片」时，把引用直接换成上传后的 URL。')
			.addToggle((toggle) =>
				toggle.setValue(this.draft.replaceEmbeds).onChange((v) => {
					this.draft.replaceEmbeds = v;
				}),
			);

		new Setting(containerEl)
			.addButton((btn) =>
				btn
					.setButtonText('保存')
					.setCta()
					.onClick(async () => {
						await this.plugin.saveSettings(this.draft);
						this.draft = { ...this.plugin.settings };
						new Notice('设置已保存');
						this.display();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText('恢复默认').onClick(async () => {
					await this.plugin.resetSettings();
					this.draft = { ...this.plugin.settings };
					this.detectMsg = '';
					new Notice('已恢复默认设置');
					this.display();
				}),
			);
	}
}
