/**
 * A bounded wait, and the one number every wait for the tree uses.
 *
 * There were three byte-identical copies of `withTimeout` in this directory
 * and two copies of the tree's timeout, which is one number written down
 * twice and a function written down three times. The link screen needed a
 * fourth of each, so they moved here instead.
 *
 * Nothing here knows about sockets or documents. It is a promise, a number
 * and a sentence to say when the number runs out, and the sentence is the
 * caller's because it is the half a person reads.
 */

/**
 * How long the tree may take to have its first exchange with the server.
 *
 * Bounded because a socket that never syncs would otherwise leave whoever
 * pressed Link waiting with nothing on screen. Giving up is better than
 * reconciling against a tree that never arrived: the caller gets a sentence
 * it can show, and the next start tries again.
 */
export const TREE_SYNC_TIMEOUT_MS = 30_000;

/** What every caller says when the tree does not arrive. */
export const TREE_SYNC_FAILED = "Could not reach the server. Nothing was changed; try again.";

/**
 * A failure that says nothing about the note: the connection went, or a wait
 * ran out. The note is fine and the same attempt may well succeed a moment
 * later, so the binding tries it again by itself rather than calling it a
 * problem (odoo-mcp-pro-admin#706: an iPhone that put Obsidian in the
 * background showed seven of these as "Could not sync").
 */
export class RetryLater extends Error {}

/** Reject with `message` if `promise` has not settled in `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new RetryLater(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
