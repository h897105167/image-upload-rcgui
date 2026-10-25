import { requestUrl } from 'obsidian';
import type { PingInfo, RcguiSettings, UploadResult } from './types';

/** The host caps multipart field sizes, so the client always posts a raw byte body. */
const PING_TIMEOUT = 2500;
const UPLOAD_TIMEOUT = 120_000;
/** Images above this size are re-encoded once before upload to keep it fast. */
const SOFT_LIMIT = 18 * 1024 * 1024;

export class UploadError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'UploadError';
	}
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new UploadError(`${what}超时（${ms}ms）`)), ms);
		p.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export class RcguiClient {
	constructor(private readonly settings: RcguiSettings) {}

	/** Root address such as `http://127.0.0.1:5273`, no trailing slash. */
	baseUrl(portOverride?: number): string {
		const custom = this.settings.serverUrl.trim();
		if (custom) return custom.replace(/\/+$/, '');
		const port = portOverride ?? this.settings.port ?? 5273;
		return `http://127.0.0.1:${port}`;
	}

	ping(portOverride?: number): Promise<PingInfo> {
		const base = this.baseUrl(portOverride);
		return withTimeout(
			requestUrl({ url: `${base}/plugin/imagehost/ping`, method: 'GET', throw: false }).then((r) => {
				if (r.status !== 200) throw new UploadError(`HTTP ${r.status}`, r.status);
				const info = r.json as PingInfo;
				if (!info || info.plugin !== 'imagehost') throw new UploadError('端口上跑的不是 imagehost 插件');
				return info;
			}),
			PING_TIMEOUT,
			'探测 RCGUI 服务',
		);
	}

	/**
	 * One-click detect: try the configured address, then 5273, then a short range scan.
	 * Returns the matched port (null when a full URL is configured and already works).
	 */
	async detect(): Promise<{ port: number | null; info: PingInfo }> {
		const tried = new Set<number>();
		const candidates: number[] = [];
		const configured = Number(this.settings.port) || 5273;
		candidates.push(configured);
		if (configured !== 5273) candidates.push(5273);
		for (let p = 5270; p <= 5285; p += 1) {
			if (!candidates.includes(p)) candidates.push(p);
		}

		let lastErr: unknown = null;
		for (const port of candidates) {
			if (tried.has(port)) continue;
			tried.add(port);
			try {
				const info = await this.ping(port);
				const usesAddress = this.settings.serverUrl.trim().length > 0;
				return { port: usesAddress ? null : port, info };
			} catch (e) {
				lastErr = e;
			}
		}
		const why = lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new UploadError(`没找到 RCGUI 的 HTTP 服务（${why}）。先确认 RCGUI 里 HTTP 服务已开启。`);
	}

	async upload(blob: Blob, filename: string): Promise<UploadResult> {
		const base = this.baseUrl();
		const url = `${base}/plugin/imagehost/upload?name=${encodeURIComponent(filename)}`;
		const body = await blob.arrayBuffer();
		const res = await withTimeout(
			requestUrl({
				url,
				method: 'POST',
				body,
				contentType: blob.type || 'application/octet-stream',
				throw: false,
			}),
			UPLOAD_TIMEOUT,
			'上传图片',
		);
		let payload: UploadResult | { ok: false; error?: string } | null = null;
		try {
			payload = res.json as UploadResult;
		} catch {
			payload = null;
		}
		if (res.status !== 200 || !payload || (payload as UploadResult).ok !== true) {
			const msg =
				(payload && 'error' in payload && payload.error) || res.text?.slice(0, 200) || `HTTP ${res.status}`;
			throw new UploadError(`上传失败：${msg}`, res.status);
		}
		return payload as UploadResult;
	}
}

export interface PreparedImage {
	blob: Blob;
	filename: string;
	resized: boolean;
	width: number;
	height: number;
}

function extOf(mime: string): string {
	if (mime === 'image/jpeg') return 'jpg';
	if (mime === 'image/webp') return 'webp';
	if (mime === 'image/gif') return 'gif';
	return 'png';
}

function replaceExt(name: string, ext: string): string {
	const base = name.replace(/\.[^.]+$/, '');
	return `${base}.${ext}`;
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new UploadError('这张图片解不开，可能不是真图片'));
		};
		img.src = url;
	});
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new UploadError('图片编码失败'))),
			mime,
			quality,
		);
	});
}

/**
 * Shrink an image to fit the configured limits:
 * 1. scale down proportionally when it exceeds maxWidth/maxHeight;
 * 2. re-encode as JPEG when the result is still above SOFT_LIMIT.
 * Animated GIFs are left alone so the animation is not flattened.
 */
export async function prepareImage(
	blob: Blob,
	filename: string,
	maxWidth: number,
	maxHeight: number,
): Promise<PreparedImage> {
	const mime = blob.type || 'image/png';
	if (mime === 'image/gif' || mime === 'image/svg+xml') {
		return { blob, filename, resized: false, width: 0, height: 0 };
	}

	let img: HTMLImageElement;
	try {
		img = await loadImage(blob);
	} catch {
		// Undecodable: send it as-is and let the server judge.
		return { blob, filename, resized: false, width: 0, height: 0 };
	}

	const limitW = Number(maxWidth) > 0 ? Number(maxWidth) : Infinity;
	const limitH = Number(maxHeight) > 0 ? Number(maxHeight) : Infinity;
	const scale = Math.min(1, limitW / img.naturalWidth, limitH / img.naturalHeight);
	const needsResize = scale < 0.999;
	const needsShrink = blob.size > SOFT_LIMIT;

	if (!needsResize && !needsShrink) {
		return { blob, filename, resized: false, width: img.naturalWidth, height: img.naturalHeight };
	}

	const width = Math.max(1, Math.round(img.naturalWidth * scale));
	const height = Math.max(1, Math.round(img.naturalHeight * scale));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return { blob, filename, resized: false, width: img.naturalWidth, height: img.naturalHeight };
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, 0, 0, width, height);

	const wantJpeg = mime === 'image/jpeg';
	let out: Blob;
	if (needsShrink) {
		out = await canvasToBlob(canvas, 'image/jpeg', 0.86);
	} else {
		out = await canvasToBlob(canvas, wantJpeg ? 'image/jpeg' : 'image/png', wantJpeg ? 0.92 : undefined);
	}
	const ext = out.type === 'image/jpeg' ? 'jpg' : extOf(out.type || mime);
	return {
		blob: out,
		filename: replaceExt(filename, ext),
		resized: true,
		width,
		height,
	};
}

/** Pick the images out of a clipboard/drop payload. */
export function imagesFrom(data: DataTransfer | null | undefined): File[] {
	if (!data) return [];
	const out: File[] = [];
	for (const item of Array.from(data.items ?? [])) {
		if (item.kind !== 'file') continue;
		const file = item.getAsFile();
		if (file && file.type.startsWith('image/')) out.push(file);
	}
	if (out.length === 0) {
		for (const file of Array.from(data.files ?? [])) {
			if (file.type.startsWith('image/')) out.push(file);
		}
	}
	return out;
}

export function stampName(file: File): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const base =
		file.name && /\.[^.]+$/.test(file.name)
			? file.name.replace(/\.[^.]+$/, '')
			: `pasted-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${base}.${extOf(file.type || 'image/png')}`;
}
