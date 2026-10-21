"use strict";

/**
 * How Pantalytics goes on the next device, said at the end rather than at the
 * start: a vault that is syncing is the moment somebody wants their phone on
 * it too.
 *
 * The plugin is installed from Community plugins and nowhere else (vault
 * ADR-0104), so there is nothing to paste: a search for the name finds it.
 *
 * Plain data, no Obsidian imports, so the copy can be pinned in a test.
 */

export const ANOTHER_DEVICE_TITLE = "Add another device";

/**
 * The steps, in the order Obsidian asks for them. The second is the whole of
 * what a second device is: the same account, then the same cloud vault picked
 * off the list.
 */
export const ANOTHER_DEVICE_STEPS: readonly string[] = [
	// Obsidian never installs a plugin update by itself; since desktop 1.11.1
	// it can check and say so, which is how a fix reaches the other device.
	"On the other device: Settings, Community plugins, Browse. Search for Pantalytics, install it and enable it. On a computer, also turn on Automatically check for plugin updates on that screen.",
	"Settings, Pantalytics, Sign in with the same account, then pick this vault from the list.",
];

/** The one line about what does not travel with the notes. */
export const ANOTHER_DEVICE_NOTE =
	"The notes come across on their own. Themes, plugins and settings stay on the device they are installed on.";
