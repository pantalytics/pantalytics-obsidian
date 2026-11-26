/**
 * Sends the drawing speed measured on this device to Pantalytics
 * (odoo-mcp-pro-admin#695), so the numbers can be read without anybody
 * reading a notice off a screen.
 *
 * Only while somebody has turned measuring on, only when signed in, at most
 * one report every REPORT_EVERY_MS. A report is counts, milliseconds and
 * bytes, the platform and the plugin's version: no path, no id, no content
 * (ADR-0003). Dropped on any failure, the way faults are.
 */

import { Platform, requestUrl, type Plugin } from "obsidian";

import { KNAP_PANEL_URL } from "../RelayOnPremConfig";
import { type DrawingLatency, drawingLatency } from "./drawingLatency";

export const REPORT_EVERY_MS = 10_000;

let credential = "";

/** The device's token on sign-in, "" on sign-out; set beside the fault one. */
export function setSpeedCredential(token: string): void {
	credential = token;
}

/** What this device is, in the words the server takes. */
export function platform(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isMacOS) return "mac";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	return "other";
}

/** Send what was measured since the last report, if anything was. */
export async function sendSpeedReport(host: Plugin, latency: DrawingLatency = drawingLatency): Promise<void> {
	if (!credential) return;
	const report = latency.takeReport();
	if (!report) return;
	try {
		await requestUrl({
			url: new URL("/metrics/drawing", KNAP_PANEL_URL).toString(),
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
			body: JSON.stringify({ ...report, platform: platform(), version: host.manifest.version }),
			throw: false,
		});
	} catch {
		// Dropped on purpose: a measurement is not worth a retry.
	}
}

export function startSpeedReports(host: Plugin): void {
	host.registerInterval(
		window.setInterval(() => {
			if (drawingLatency.measuring) void sendSpeedReport(host);
		}, REPORT_EVERY_MS),
	);
}
