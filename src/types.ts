/** Plugin settings, persisted to data.json; nothing applies until the Save button is pressed. */
export interface RcguiSettings {
	/** HTTP port of the RCGUI host (the port field in its settings page). */
	port: number;
	/** Optional full base URL; when set it wins over the port (remote host or custom hostname). */
	serverUrl: string;
	/** Max width for the image as drawn in the note (embed size). 0 = unlimited. */
	maxWidth: number;
	/** Max height for the image as drawn in the note (embed size). 0 = unlimited. */
	maxHeight: number;
	/** Also re-encode the file itself down to those limits (off by default: only the display size changes). */
	shrinkPixels: boolean;
	/** Upload pasted images automatically. */
	autoUploadOnPaste: boolean;
	/** Delete the vault's local copy once the upload succeeded. */
	deleteLocalFile: boolean;
	/** Return the direct link or the short link. */
	linkKind: 'direct' | 'short';
	/** Also rewrite wiki embeds like `![[img.png]]` into plain URLs. */
	replaceEmbeds: boolean;
}

export const DEFAULT_SETTINGS: RcguiSettings = {
	port: 5273,
	serverUrl: '',
	maxWidth: 300,
	maxHeight: 300,
	shrinkPixels: false,
	autoUploadOnPaste: true,
	deleteLocalFile: true,
	linkKind: 'direct',
	replaceEmbeds: true,
};

/** Response of `GET /plugin/imagehost/ping`. */
export interface PingInfo {
	ok: boolean;
	plugin: string;
	version: string;
	port: number;
	upload_url: string;
	upload_path: string;
	accept: string;
	max_mb: number;
	max_bytes: number;
	compress: boolean;
	short: boolean;
	remote: string;
	dir: string;
}

/** Response of `POST /plugin/imagehost/upload`. */
export interface UploadResult {
	ok: boolean;
	url: string;
	short_url: string | null;
	name: string;
	stored: string;
	remote: string;
	content_type: string;
	size: number;
	original_size: number;
	compressed: boolean;
	note?: string;
	deduped: boolean;
	short_error?: string;
}
