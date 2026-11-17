/**
 * How long a stroke takes from one screen to the other (odoo-mcp-pro-admin#695).
 *
 * A measuring tool, off unless somebody turns it on. Two devices' clocks do
 * not agree to the millisecond, so nothing here compares them: the device
 * that draws stamps each element version it sends, the device that receives
 * echoes the versions it has put on screen over awareness, and the drawer
 * times the round trip on its own clock. The receiver also says how long
 * `updateScene` took, so the trip can be split:
 *
 * - wait: from the first change since the last send to the send itself
 *   (LiveDrawing sends at most every SEND_EVERY_MS);
 * - transit: half of the round trip, less the receiver's updateScene;
 * - render: the receiver's updateScene;
 * - pen to screen: the three together.
 *
 * Nothing leaves the two devices: ids and versions ride the awareness the
 * pointers already use, and the numbers stay in memory (ADR-0003).
 */

/** On the drawer's awareness while it measures: receivers echo only then. */
export const MEASURE_FIELD = "drawingMeasure";
/** On the receiver's awareness: which versions it just put on screen. */
export const SEEN_FIELD = "drawingSeen";

export interface Seen {
	keys: string[];
	renderMs: number;
}

interface Sample {
	waitMs: number;
	transitMs: number;
	renderMs: number;
	bytes: number;
}

const KEEP = 2000;

export function keyOf(element: { id: string; version: number }): string {
	return `${element.id}:${element.version}`;
}

export class DrawingLatency {
	measuring = false;
	private pending = new Map<string, { at: number; waitMs: number; bytes: number }>();
	private samples: Sample[] = [];

	constructor(private readonly now: () => number = () => performance.now()) {}

	start(): void {
		this.measuring = true;
		this.pending.clear();
		this.samples = [];
	}

	stop(): void {
		this.measuring = false;
		this.pending.clear();
	}

	/** The drawer sent these versions, after waiting `waitMs`, in `bytes`. */
	sent(keys: string[], waitMs: number, bytes: number): void {
		if (!this.measuring) return;
		const at = this.now();
		for (const key of keys) this.pending.set(key, { at, waitMs, bytes });
		while (this.pending.size > KEEP) this.pending.delete(this.pending.keys().next().value as string);
	}

	/** Another device says it put these versions on screen. */
	echoed(seen: Seen): void {
		if (!this.measuring) return;
		const at = this.now();
		for (const key of seen.keys) {
			const sent = this.pending.get(key);
			if (!sent) continue;
			this.pending.delete(key);
			const transitMs = Math.max(0, (at - sent.at - seen.renderMs) / 2);
			this.samples.push({ waitMs: sent.waitMs, transitMs, renderMs: seen.renderMs, bytes: sent.bytes });
		}
		if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
	}

	/** One paragraph a person can read off a notice, or "nothing yet". */
	summary(): string {
		const n = this.samples.length;
		if (n === 0) return "No strokes measured yet. Draw with the drawing open on another device.";
		const pen = this.samples.map((s) => s.waitMs + s.transitMs + s.renderMs);
		const part = (pick: (s: Sample) => number) => this.samples.map(pick);
		return [
			`${n} updates measured.`,
			`Pen to screen: ${stats(pen)}.`,
			`Wait before sending: ${stats(part((s) => s.waitMs))}.`,
			`Transit: ${stats(part((s) => s.transitMs))}.`,
			`Drawing on the other screen: ${stats(part((s) => s.renderMs))}.`,
			`Size per update: median ${kb(median(part((s) => s.bytes)))}, largest ${kb(Math.max(...part((s) => s.bytes)))}.`,
		].join("\n");
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

function stats(values: number[]): string {
	const sorted = [...values].sort((a, b) => a - b);
	const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
	return `median ${Math.round(median(values))} ms, p95 ${Math.round(p95)} ms, max ${Math.round(sorted[sorted.length - 1])} ms`;
}

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The one this plugin measures with; the commands turn it on and read it. */
export const drawingLatency = new DrawingLatency();
