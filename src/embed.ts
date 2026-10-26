/**
 * Display-size limiting through Obsidian embed syntax.
 *
 * A hosted image is referenced as `![|300x200](https://...)`: the numbers only
 * change how large the image is drawn inside the note, the stored file keeps
 * its original pixels. Both axes are derived from one shared scale factor, so
 * the aspect ratio is preserved instead of being stretched to the box.
 */

export interface Fit {
	/** Display width in px. */
	width: number;
	/** Display height in px. */
	height: number;
	/** True when the natural size was larger than the allowed box. */
	scaled: boolean;
}

function limit(value: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Fit a natural size into the allowed box, keeping the aspect ratio.
 * Returns `scaled: false` with the natural size when it already fits, and when
 * the natural size is unknown (0) nothing can be computed.
 */
export function fitForDisplay(
	naturalWidth: number,
	naturalHeight: number,
	maxWidth: number,
	maxHeight: number,
): Fit {
	const w = Number(naturalWidth);
	const h = Number(naturalHeight);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return { width: 0, height: 0, scaled: false };
	}
	const scale = Math.min(1, limit(maxWidth) / w, limit(maxHeight) / h);
	if (scale >= 0.999) return { width: Math.round(w), height: Math.round(h), scaled: false };
	return {
		width: Math.max(1, Math.round(w * scale)),
		height: Math.max(1, Math.round(h * scale)),
		scaled: true,
	};
}

/** `|300x200` when the image must be shrunk for display, otherwise an empty string. */
export function displaySuffix(fit: Fit): string {
	return fit.scaled ? `|${fit.width}x${fit.height}` : '';
}

/**
 * Markdown for one hosted image.
 * `keepSuffix` is an author-supplied size (e.g. `|400`) taken from the embed
 * being replaced: an explicit size outranks the configured one.
 * `alt` preserves the caption of a converted `![alt](path)` link.
 */
export function embedMarkdown(url: string, fit: Fit, keepSuffix = '', alt = ''): string {
	const suffix = keepSuffix.trim() || displaySuffix(fit);
	return `![${alt}${suffix}](${url})`;
}
