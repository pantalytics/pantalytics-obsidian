import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument } from "./S3RN";
import { isDocument, type Document } from "./Document";
import { isCanvas } from "./Canvas";
import type { TimeProvider } from "./TimeProvider";
import { HasLogging, RelayInstances } from "./debug";
import type { Subscriber, Unsubscriber } from "./observable/Observable";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import { openFirst } from "./FolderSort";
import type { ClientToken } from "./client/types";
import { Canvas } from "./Canvas";
import { areObjectsEqual } from "./areObjectsEqual";
import type { CanvasData } from "./CanvasView";
import { SyncFile, isSyncFile } from "./SyncFile";
import { reconcileWithConflictCopy } from "./y-diffMatchPatch";
import { waitForBufferFlush } from "./websocketFlush";
import { claimInitIfUnclaimed, wonInitClaim, markInitDone, awaitClaimSettled } from "./initContentClaim";
import { owed, stateFor } from "./knapPresence";
import { MAX_BATCH_DOCS } from "./auth/RelayOnPremTokenProvider";
import { reportFault } from "./faults";

export interface QueueItem {
	guid: string;
	path: string;
	doc: Document | Canvas | SyncFile;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
}

export interface SyncGroup {
	sharedFolder: SharedFolder;
	total: number; // Total operations (syncs + downloads)
	completed: number; // Total completed operations
	status: "pending" | "running" | "completed" | "failed";
	downloads: number;
	syncs: number;
	completedDownloads: number;
	completedSyncs: number;
}

export interface SyncProgress {
	totalPercent: number;
	syncPercent: number;
	downloadPercent: number;
	totalItems: number;
	completedItems: number;
	syncItems: number;
	completedSyncs: number;
	downloadItems: number;
	completedDownloads: number;
}

export interface GroupProgress {
	percent: number;
	syncPercent: number;
	downloadPercent: number;
	sharedFolder: SharedFolder;
	status: "pending" | "running" | "completed" | "failed";
}

/** How much of one folder's work is behind us, in notes rather than percent. */
export interface FolderWork {
	/** Notes this folder's passes have taken on, sends and fetches together. */
	total: number;
	/** How many of them came back with a body actually written. */
	completed: number;
}

export class BackgroundSync extends HasLogging {
	public activeSync = new ObservableSet<QueueItem>();
	public activeDownloads = new ObservableSet<QueueItem>();
	public syncGroups = new ObservableMap<SharedFolder, SyncGroup>();

	private syncQueue: QueueItem[] = [];
	/** The notes open on screen, as Obsidian names them; see `prioritize`. */
	private openPaths = new Set<string>();
	/** Open notes first, then path order. */
	private order = openFirst((path) => this.openPaths.has(path));
	private downloadQueue: QueueItem[] = [];
	private isProcessingSync = false;
	private isProcessingDownloads = false;
	private isPaused = true;
	private inProgressSyncs = new Set<string>();
	private inProgressDownloads = new Set<string>();
	private syncCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();
	private downloadCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();

	// A map to track items we've already logged to avoid duplicates
	private loggedItems = new Map<string, boolean>();

	subscriptions: Unsubscriber[] = [];

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
		// Eight at a time, the same width Knap's own copying settled on
		// (ADR-0054). Three was set when every document also queued for its
		// own token request; with the tokens warmed ahead in batches the
		// connection is the whole cost, and three connections left a first
		// sync waiting on round trips it did not need to.
		private concurrency: number = 8,
	) {
		super();
		RelayInstances.set(this, "BackgroundSync");
		this.timeProvider.setInterval(() => {
			void this.processSyncQueue();
			void this.processDownloadQueue();
		}, 1000);
		// Tell each cloud vault what this device is doing with it. Here rather
		// than in SharedFolder because this is the only object that knows what
		// is still queued, in each direction, which is the half Knap's page
		// cannot work out and the half somebody can act on.
		//
		// Five seconds matches what that page polls at, so a number on screen
		// is never more than one tick behind the queue it came from. It is
		// cheap: awareness never enters the document, and an unchanged report
		// goes out at most every ten seconds (`SharedFolder.shouldRepublish`).
		this.timeProvider.setInterval(() => {
			this.reportToKnap();
		}, 5000);
	}

	/**
	 * Publish this device's state into every vault it syncs.
	 *
	 * Never throws: it sits on a timer beside the queues that move somebody's
	 * notes, and a readout on a web page is not worth risking either of them.
	 */
	reportToKnap(): void {
		const signedIn = !!this.loginManager.loggedIn;
		this.sharedFolders.items().forEach((folder) => {
			try {
				const { up, down } = owed(this.syncGroups.get(folder));
				folder.reportToKnap({
					state: stateFor({ signedIn, paused: this.isPaused, up, down }),
					up,
					down,
				});
			} catch (e) {
				this.warn("could not report this device's state", e);
			}
		});
	}

	/**
	 * Returns items currently in the sync queue
	 */
	public get pendingSyncs(): readonly QueueItem[] {
		return this.syncQueue;
	}

	/**
	 * Returns items currently in the download queue
	 */
	public get pendingDownloads(): readonly QueueItem[] {
		return this.downloadQueue;
	}

	getOverallProgress(): SyncProgress {
		let totalItems = 0;
		let completedItems = 0;
		let syncItems = 0;
		let completedSyncs = 0;
		let downloadItems = 0;
		let completedDownloads = 0;

		this.syncGroups.forEach((group) => {
			totalItems += group.total;
			completedItems += group.completed;
			syncItems += group.syncs;
			completedSyncs += group.completedSyncs;
			downloadItems += group.downloads;
			completedDownloads += group.completedDownloads;
		});

		const totalPercent =
			totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
		const syncPercent = syncItems > 0 ? (completedSyncs / syncItems) * 100 : 0;
		const downloadPercent =
			downloadItems > 0 ? (completedDownloads / downloadItems) * 100 : 0;

		return {
			totalPercent: Math.round(totalPercent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			totalItems,
			completedItems,
			syncItems,
			completedSyncs,
			downloadItems,
			completedDownloads,
		};
	}

	getGroupProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const percent = group.total > 0 ? (group.completed / group.total) * 100 : 0;
		const syncPercent =
			group.syncs > 0 ? (group.completedSyncs / group.syncs) * 100 : 0;
		const downloadPercent =
			group.downloads > 0
				? (group.completedDownloads / group.downloads) * 100
				: 0;

		return {
			percent: Math.round(percent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			sharedFolder,
			status: group.status,
		};
	}

	/**
	 * One folder's work, as two counts.
	 *
	 * `getGroupProgress` rounds to a percentage, and a percentage is the wrong
	 * shape for a status that must not go green early: 2,566 notes out of
	 * 2,567 rounds to 100. This hands back the counts and lets the caller
	 * compare them itself.
	 *
	 * `completed` only counts a note whose body actually got written. A sync
	 * that came back without one is marked failed rather than done (#38), so
	 * `completed` short of `total` covers the notes still queued and the notes
	 * that came back empty alike, and both mean the same thing to somebody
	 * reading the corner of the window: this vault is not all up yet.
	 */
	getFolderWork(sharedFolder: SharedFolder): FolderWork {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) {
			return { total: 0, completed: 0 };
		}
		return { total: group.total, completed: group.completed };
	}

	getAllGroupsProgress(): GroupProgress[] {
		const progress: GroupProgress[] = [];
		this.syncGroups.forEach((group, sharedFolder) => {
			const groupProgress = this.getGroupProgress(sharedFolder);
			if (groupProgress) {
				progress.push(groupProgress);
			}
		});
		return progress;
	}

	/**
	 * Ask for the tokens the queues will need next, ahead of admitting the
	 * work. The token store dedupes and caches, so on most ticks this is a
	 * hundred map lookups and no requests; when the window slides over new
	 * items, the newcomers coalesce into one batch request. Without this the
	 * batch route was starved: only the few admitted syncs ever waited on a
	 * token, so a request built for a hundred documents carried three.
	 *
	 * The window is one batch wide on purpose. Tokens live five minutes, and
	 * warming further ahead than the queue can spend inside that window is
	 * signatures thrown away.
	 */
	private warmUpcomingTokens() {
		const upcoming = [...(this.syncQueue ?? []), ...(this.downloadQueue ?? [])]
			.filter((item) => item.sharedFolder.connected)
			.slice(0, MAX_BATCH_DOCS);
		for (const item of upcoming) {
			const doc = item.doc;
			if (doc instanceof SyncFile) {
				// Attachments mint per-operation file tokens, on their own
				// pacing; there is nothing to warm.
				continue;
			}
			void doc.tokenStore?.warm(S3RN.encode(doc.s3rn), doc.getVaultPath());
		}
	}

	private processSyncQueue() {
		if (this.isPaused || this.isProcessingSync) return;
		this.isProcessingSync = true;

		this.warmUpcomingTokens();

		// Filter for items with connected folders
		const connectableItems = this.syncQueue.filter(
			(item) => item.sharedFolder.connected,
		);

		while (
			connectableItems.length > 0 &&
			this.activeSync.size < this.concurrency
		) {
			const item = connectableItems.shift();
			if (!item) break;

			// Remove this item from the main queue
			this.syncQueue = this.syncQueue.filter((i) => i.guid !== item.guid);

			item.status = "running";
			this.activeSync.add(item);

			try {
				const doc = item.doc;
				let syncPromise: Promise<unknown>;

				if (doc instanceof SyncFile) {
					syncPromise = this.syncFile(doc);
				} else {
					syncPromise = this.syncDocument(doc);
				}

				syncPromise
					.then((result: unknown) => {
						const callback = this.syncCompletionCallbacks.get(item.guid);

						// A document sync that answers false came back without
						// writing the body. Counting it as a completed sync is
						// what let a fill of thousands of notes finish, write
						// none of them, and say it was up to date (#38). The
						// waiting caller is still released, because the queue
						// promise is a sequencing barrier rather than a result,
						// and rejecting it here would only produce unhandled
						// rejections at the callers that fire and forget.
						if (result === false) {
							item.status = "failed";
							this.warn("[Sync Incomplete]", item.path);
							if (callback) {
								callback.resolve();
								this.syncCompletionCallbacks.delete(item.guid);
							}
							const failedGroup = this.syncGroups.get(item.sharedFolder);
							if (failedGroup) {
								failedGroup.status = "failed";
								this.syncGroups.set(item.sharedFolder, failedGroup);
							}
							return;
						}

						item.status = "completed";
						if (callback) {
							callback.resolve();
							this.syncCompletionCallbacks.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							this.debug(
								`[Sync Progress] Before: completed=${group.completed}, total=${group.total}, ` +
									`syncs=${group.syncs}, completedSyncs=${group.completedSyncs}`,
							);

							group.completedSyncs++;
							group.completed++;

							this.debug(
								`[Sync Progress] After: completed=${group.completed}, total=${group.total}, ` +
									`syncs=${group.syncs}, completedSyncs=${group.completedSyncs}`,
							);

							if (group.completed === group.total) {
								group.status = "completed";
								this.debug("[Sync Progress] Group completed!");
							}

							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.catch((error: unknown) => {
						item.status = "failed";

						const callback = this.syncCompletionCallbacks.get(item.guid);
						if (callback) {
							callback.reject(
								error instanceof Error ? error : new Error(String(error)),
							);
							this.syncCompletionCallbacks.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							this.error("[Sync Failed]", error);
							reportFault("sync", error);
							group.status = "failed";
							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.finally(() => {
						this.activeSync.delete(item);
						this.inProgressSyncs.delete(item.guid);

						// Unwind the call stack before checking for more work
						this.timeProvider.setTimeout(() => {
							void this.processSyncQueue();
						}, 0);
					});
			} catch (error: unknown) {
				item.status = "failed";

				const callback = this.syncCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.syncCompletionCallbacks.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Sync Startup Failed]", error);
					reportFault("sync", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}

				this.activeSync.delete(item);
				this.inProgressSyncs.delete(item.guid);
			}
		}

		this.isProcessingSync = false;
	}

	private processDownloadQueue() {
		if (this.isPaused || this.isProcessingDownloads) return;
		this.isProcessingDownloads = true;

		// Filter for items with connected folders
		const connectableItems = this.downloadQueue.filter(
			(item) => item.sharedFolder.connected,
		);

		while (
			connectableItems.length > 0 &&
			this.activeDownloads.size < this.concurrency
		) {
			const item = connectableItems.shift();
			if (!item) break;

			// Remove this item from the main queue
			this.downloadQueue = this.downloadQueue.filter(
				(i) => i.guid !== item.guid,
			);

			item.status = "running";
			this.activeDownloads.add(item);

			try {
				let downloadPromise: Promise<unknown>;

				// Choose the appropriate download method based on the document type
				if (item.doc instanceof Canvas) {
					downloadPromise = this.getCanvas(item.doc);
				} else if (item.doc instanceof SyncFile) {
					downloadPromise = this.getSyncFile(item.doc);
				} else {
					downloadPromise = this.getDocument(item.doc);
				}

				downloadPromise
					.then(() => {
						item.status = "completed";

						const callback = this.downloadCompletionCallbacks.get(item.guid);
						if (callback) {
							callback.resolve();
							this.downloadCompletionCallbacks.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							group.completedDownloads++;
							group.completed++;
							if (group.completed === group.total) {
								group.status = "completed";
							}
							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.catch((error: unknown) => {
						item.status = "failed";

						const callback = this.downloadCompletionCallbacks.get(item.guid);
						if (callback) {
							callback.reject(
								error instanceof Error ? error : new Error(String(error)),
							);
							this.downloadCompletionCallbacks.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							group.status = "failed";
							this.syncGroups.set(item.sharedFolder, group);
						}
						this.error("[processDownloadQueue]", error);
					})
					.finally(() => {
						this.activeDownloads.delete(item);
						this.inProgressDownloads.delete(item.guid);

						// Unwind the call stack before checking for more work
						this.timeProvider.setTimeout(() => {
							void this.processDownloadQueue();
						}, 0);
					});
			} catch (error: unknown) {
				item.status = "failed";

				const callback = this.downloadCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.downloadCompletionCallbacks.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Download Startup Failed]", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}

				this.activeDownloads.delete(item);
				this.inProgressDownloads.delete(item.guid);
			}
		}

		this.isProcessingDownloads = false;
	}

	/**
	 * Enqueues a document for synchronization
	 *
	 * This method adds a document to the sync queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to synchronize
	 * @returns A promise that resolves when the sync completes
	 */
	async enqueueSync(item: SyncFile | Document | Canvas): Promise<void> {
		// Skip if already in progress
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueSync] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.syncCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			void this.processSyncQueue();
			return Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		// Get or create the sync group
		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
			};
		}
		group.total++;
		group.syncs++;
		this.syncGroups.set(sharedFolder, group);

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(this.order);
		void this.processSyncQueue();

		return syncPromise;
	}

	/**
	 * Move the notes open on screen to the front of both queues.
	 *
	 * Called every time a note is opened or the layout changes, so a note
	 * opened halfway through a first sync jumps ahead of the rest instead of
	 * waiting its turn.
	 */
	prioritize(openPaths: Iterable<string>): void {
		this.openPaths = new Set(openPaths);
		this.syncQueue.sort(this.order);
		this.downloadQueue.sort(this.order);
		void this.processSyncQueue();
		void this.processDownloadQueue();
	}

	/**
	 * Enqueues a document for download
	 *
	 * This method adds a document to the download queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueDownload(item: SyncFile | Document | Canvas): Promise<void> {
		// Skip if already in progress
		if (this.inProgressDownloads.has(item.guid)) {
			this.debug(
				`[enqueueDownload] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.downloadCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				void this.processDownloadQueue();
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			void this.processDownloadQueue();
			return Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;

		// Get or create the sync group for this folder
		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
			};
		}

		// Update the counters for individual document download
		group.downloads++;
		group.total++;
		this.syncGroups.set(sharedFolder, group);

		// Create the queue item
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		// Mark as in progress
		this.inProgressDownloads.add(item.guid);

		// Create a promise that will resolve when the download completes
		const downloadPromise = new Promise<void>((resolve, reject) => {
			this.downloadCompletionCallbacks.set(item.guid, { resolve, reject });
		});

		// Add to the queue and start processing
		this.downloadQueue.push(queueItem);
		this.downloadQueue.sort(this.order);
		void this.processDownloadQueue();

		return downloadPromise;
	}

	/**
	 * Enqueues all documents and canvases in a shared folder for synchronization
	 *
	 * This method creates a sync group to track the progress of synchronizing
	 * all documents and canvases in a shared folder, then enqueues each item for sync.
	 * It handles counter initialization correctly to avoid double-counting.
	 *
	 * @param sharedFolder The shared folder to synchronize
	 */
	enqueueSharedFolderSync(sharedFolder: SharedFolder): void {
		// Get all documents and canvases in the shared folder
		const docs = [...sharedFolder.files.values()].filter(isDocument);
		const canvases = [...sharedFolder.files.values()].filter(isCanvas);
		const syncFiles = [...sharedFolder.files.values()].filter(isSyncFile);
		const allItems = [...docs, ...canvases, ...syncFiles];

		// Create sync group with properly initialized counters
		const group: SyncGroup = {
			sharedFolder,
			total: allItems.length,
			completed: 0,
			status: "pending",
			downloads: 0,
			syncs: allItems.length,
			completedDownloads: 0,
			completedSyncs: 0,
		};

		// Register the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);

		// Sort items by path for consistent sync order
		const sortedDocs = [...docs, ...canvases, ...syncFiles].sort(
			this.order,
		);


		for (const doc of sortedDocs) {
			void this.enqueueForGroupSync(doc);
		}

		// Update group status to running
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);
	}

	/**
	 * Enqueues an item for synchronization as part of a group sync operation
	 *
	 * This method is similar to enqueueSync() but doesn't increment any counters
	 * since they're already properly initialized in enqueueSharedFolderSync().
	 * This prevents double-counting of operations in progress tracking.
	 *
	 * @param item The item to synchronize (Document, Canvas, or SyncFile)
	 * @returns A promise that resolves when the sync completes
	 * @private Used internally by enqueueSharedFolderSync
	 */
	private async enqueueForGroupSync(
		item: Document | Canvas | SyncFile,
	): Promise<void> {
		// Skip if already in progress
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueForGroupSync] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.syncCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				void this.processSyncQueue();
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			return Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(this.order);
		void this.processSyncQueue();

		return syncPromise;
	}

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
		};
	}

	private getBaseUrl(
		clientToken: ClientToken,
		entity: S3RemoteDocument | S3RemoteCanvas,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		const baseUrl =
			clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();

		return baseUrl;
	}

	async downloadItem(item: Document | Canvas): Promise<RequestUrlResponse> {
		const getId = (entity: S3RemoteCanvas | S3RemoteDocument) => {
			if (entity instanceof S3RemoteCanvas) {
				return entity.canvasId;
			}
			return entity.documentId;
		};
		const entity = item.s3rn;
		this.log("[downloadItem]", item.path, `${S3RN.encode(entity)}`);

		if (
			!(entity instanceof S3RemoteDocument || entity instanceof S3RemoteCanvas)
		) {
			throw new Error(`Unable to decode S3RN: ${S3RN.encode(entity)}`);
		}

		const clientToken = await item.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrl({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", getId(entity), response.status);
		} else {
			if (response.status === 401) {
				// CWT tokens are not accepted for HTTP endpoints on y-sweet relay-server.
				// This is expected — WebSocket sync handles document synchronization.
				this.warn("[downloadItem] HTTP auth failed (expected with CWT tokens):", getId(entity), response.status);
			} else {
				this.error(
					"[downloadItem]",
					getId(entity),
					url,
					response.status,
					response.text,
				);
			}
			throw new Error(`Unable to download item: ${S3RN.encode(entity)}`);
		}
		return response;
	}

	async syncDocumentWebsocket(doc: Document | Canvas): Promise<boolean> {
		// if the local file is synced, then we do the two step process
		// check if file is tracking
		let currentFileContents = "";

		// Handle different document types
		let currentTextStr = "";
		let currentCanvasData: CanvasData | null = null;

		if (isCanvas(doc)) {
			// Store the exported canvas data rather than a stringified version
			currentCanvasData = Canvas.exportCanvasData(doc.ydoc);
			currentTextStr = JSON.stringify(currentCanvasData);
		} else if (isDocument(doc)) {
			currentTextStr = doc.text;
		}
		// A file we cannot read and a file that is not there are two different
		// answers, and treating both as "" was the quietest way this ended
		// with an empty document on the relay and a green tick next to it
		// (#38): "" matches an empty Y.Text, so the insert below is skipped
		// and the sync reports success. Ask first, and if a file that is
		// there will not open, stop rather than guess at its contents.
		let fileExists = false;
		try {
			fileExists = await doc.sharedFolder.exists(doc);
		} catch (e: unknown) {
			this.warn(
				"[syncDocumentWebsocket] could not tell whether the file exists",
				doc.path,
				e,
			);
		}
		if (fileExists) {
			try {
				currentFileContents = await doc.sharedFolder.read(doc);
			} catch (e: unknown) {
				this.error(
					"[syncDocumentWebsocket] could not read the local file, leaving it alone",
					doc.path,
					e,
				);
				return false;
			}
		} else {
			this.debug(
				"[syncDocumentWebsocket] no local file yet, this one comes from the relay",
				doc.path,
			);
		}

		// Only proceed with update if file matches current ydoc state
		let contentsMatch = false;
		if (isCanvas(doc) && currentCanvasData) {
			// For canvas, use deep object comparison instead of string equality
			const currentFileJson = currentFileContents
				? JSON.parse(currentFileContents) as unknown
				: { nodes: [], edges: [] };
			contentsMatch = areObjectsEqual(currentCanvasData, currentFileJson);
		} else {
			contentsMatch = currentTextStr === currentFileContents;
		}

		// NB: despite the name, this is true for ANY doc in a Team-Relay-linked
		// SharedFolder (hosted tr.entire.vc relays included, not just self-hosted
		// on-prem ones) — `relayId` is set whenever a folder belongs to a Relay,
		// full stop. Non-relay Local Sync folders are the `false` case below.
		const isRelayOnPrem = !!doc.sharedFolder.relayId;

		if (!contentsMatch && currentFileContents) {
			if (!isRelayOnPrem) {
				this.log(
					"file is not tracking local disk. resolve merge conflicts before syncing.",
				);
				return false;
			}
			// For relay-linked folders: Y.Text is likely empty (new Document) while
			// the file has content. We need to connect to the relay to get the
			// authoritative server state first, then reconcile. Skipping would leave
			// Documents permanently unsynced.
		}

		const promise = doc.onceProviderSynced();
		const intent = doc.intent;
		const connected = await doc.connect();
		if (!connected) {
			this.warn(
				"[syncDocumentWebsocket] connect failed, body not written for",
				doc.path,
			);
			return false;
		}
		if (intent === "disconnected") {
			// Add timeout to prevent infinite hang if provider never syncs
			// (e.g., document disconnected by parent during connection)
			const timeout = new Promise<void>((_, reject) =>
				window.setTimeout(() => reject(new Error("WS sync timeout")), 30000),
			);
			try {
				await Promise.race([promise, timeout]);
			} catch {
				this.warn(
					"[syncDocumentWebsocket] timed out waiting for the relay, body not written for",
					doc.path,
				);
				if (!doc.userLock) {
					doc.disconnect();
				}
				return false;
			}
		}

		// For relay-linked folders (hosted or on-prem, see note above): after
		// syncing with the relay, reconcile content. The vault file is treated as
		// the source of truth for edits that weren't committed to Y.Doc (e.g. the
		// file was modified without an active editor binding) — but see
		// reconcileWithConflictCopy: it never discards divergent Y.Doc content
		// without preserving it first.
		if (isRelayOnPrem && !contentsMatch && currentFileContents && isDocument(doc)) {
			const syncedText = doc.text;
			if (!syncedText) {
				// Relay had no content. Two clients opening the same brand-new
				// shared folder at once would otherwise BOTH insert here and Yjs
				// would merge both blocks (duplicated text, TR-15) — claim a slot
				// first, give a concurrent claim from another client a settle
				// window to arrive over the relay, then only the deterministic
				// winner inserts. See initContentClaim.ts for the mechanism.
				claimInitIfUnclaimed(doc.ydoc, doc._provider.awareness);
				await awaitClaimSettled(doc.ydoc, { socket: doc._provider.ws });
				const text = doc.ydoc.getText("contents");
				if (wonInitClaim(doc.ydoc, text)) {
					this.log(
						`[syncDocumentWebsocket] Uploading new content for ${doc.path} (${currentFileContents.length} chars)`,
					);
					text.insert(0, currentFileContents);
					markInitDone(doc.ydoc);
				} else if (text.length === 0) {
					this.warn(
						`[syncDocumentWebsocket] Skipped initial-content insert for ${doc.path} — lost the init claim to a concurrently-connecting client`,
					);
				}
			} else if (syncedText !== currentFileContents) {
				// Relay has stale/different content — reconcile with vault file.
				// `syncedText` at this point may include edits from OTHER clients
				// that just merged in via the connect()/onceProviderSynced() above;
				// a plain text diff can't tell those apart from this device's own
				// unsynced edits, so before rewriting the Y.Doc to match the vault
				// file we preserve whatever it currently holds as a conflict-copy
				// file (TR-01, #814d6d9b) — nothing is silently discarded, and if
				// the preserve step itself fails we skip reconciling rather than
				// risk it.
				// `currentFileContents` was read before connect() and before the
				// wait on onceProviderSynced(), which is allowed to take up to
				// 30 seconds. Plugins that write through vault.modify — Kanban
				// and Excalidraw both do — can rewrite the file inside that
				// window, and reconciling would then push a stale disk state
				// into the Y.Doc and from there back over the file. Re-read and
				// bail if the file moved under us; the next sync round picks it
				// up with a fresh read. Fail closed if the re-read throws.
				let latestFileContents: string;
				try {
					latestFileContents = await doc.sharedFolder.read(doc);
				} catch (e: unknown) {
					this.warn(
						`[syncDocumentWebsocket] Skipped reconciliation for ${doc.path} — ` +
							`could not re-read the vault file to check it is still current`,
						e,
					);
					return false;
				}
				if (latestFileContents !== currentFileContents) {
					this.log(
						`[syncDocumentWebsocket] Skipped reconciliation for ${doc.path} — ` +
							`the vault file changed while we waited for the relay ` +
							`(read=${currentFileContents.length}, now=${latestFileContents.length})`,
					);
					return false;
				}

				const timestamp = new Date()
					.toISOString()
					.replace(/[:.]/g, "-");
				const result = await reconcileWithConflictCopy(
					doc.ydoc,
					currentFileContents,
					(relayContent) =>
						doc.sharedFolder.writeConflictCopy(
							doc,
							relayContent,
							`relay conflict ${timestamp}`,
						),
					undefined,
					(...args) => this.log("[syncDocumentWebsocket]", ...args),
				);
				if (result.reconciled) {
					this.log(
						`[syncDocumentWebsocket] Reconciled ${doc.path} with vault file ` +
							`(relay=${syncedText.length}, vault=${currentFileContents.length}); ` +
							`prior relay content preserved at ${result.conflictPath}`,
					);
				} else {
					this.warn(
						`[syncDocumentWebsocket] Skipped reconciliation for ${doc.path} — ` +
							`could not safely preserve relay content before overwriting`,
					);
				}
			}
			// Wait for the reconcile update to actually leave the local send
			// buffer before disconnecting, instead of hoping a fixed 1000ms
			// window was long enough — a large diff on a slow link can still
			// be sitting in bufferedAmount well past a fixed timer, and
			// disconnecting at that point drops it silently (TR-51, #1cf58421).
			await waitForBufferFlush(doc._provider.ws);
		}

		// promise can take some time
		if (intent === "disconnected" && !doc.userLock) {
			doc.disconnect();
			doc.sharedFolder.tokenStore.removeFromRefreshQueue(S3RN.encode(doc.s3rn));
		}
		return true;
	}

	/**
	 * Enqueues a document to be downloaded from the server
	 * @param canvas The canvas to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueCanvasDownload(canvas: Canvas): Promise<void> {
		return this.enqueueDownload(canvas);
	}

	async getCanvas(canvas: Canvas, retry = 3, wait = 3000) {
		try {
			// Get the current contents before applying the update
			const currentJson = Canvas.exportCanvasData(canvas.ydoc);
			let currentFileContents: CanvasData = { edges: [], nodes: [] };
			try {
				const stringContents = await canvas.sharedFolder.read(canvas);
				currentFileContents = JSON.parse(stringContents) as CanvasData;
			} catch {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch =
				areObjectsEqual(currentJson.edges, currentFileContents.edges) &&
				areObjectsEqual(currentJson.nodes, currentFileContents.nodes);
			const hasContents = currentFileContents.nodes.length > 0;

			const response = await this.downloadItem(canvas);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			this.log("[getCanvas] applying content from server");
			Y.applyUpdate(canvas.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (canvas.sharedFolder.syncStore.has(canvas.path)) {
				void canvas.sharedFolder.flush(canvas, canvas.json);
				this.log("[getCanvas] flushed");
			}
		} catch (e: unknown) {
			// HTTP download failed (e.g., CWT tokens not accepted for HTTP endpoints).
			// Fall back to WebSocket sync for the canvas content.
			this.warn("[getCanvas] HTTP download failed, falling back to WS sync:", (e as Error).message);
			try {
				const synced = await this.syncDocumentWebsocket(canvas);
				if (synced && canvas.sharedFolder.syncStore.has(canvas.path)) {
					void canvas.sharedFolder.flush(canvas, canvas.json);
					this.log("[getCanvas] WS sync fallback successful, flushed to disk");
				}
			} catch (wsError: unknown) {
				this.error("[getCanvas] WS sync fallback also failed:", wsError);
			}
			return;
		}
	}

	private async getDocument(doc: Document, retry = 3, wait = 3000) {
		try {
			// Get the current contents before applying the update
			const currentText = doc.text;
			let currentFileContents = "";
			try {
				currentFileContents = await doc.sharedFolder.read(doc);
			} catch {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch = currentText === currentFileContents;
			const hasContents = currentFileContents !== "";

			const response = await this.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Check for newly created documents without content, and reject them
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);
			const users = newDoc.getMap("users");
			const contents = newDoc.getText("contents").toJSON();

			if (contents === "") {
				if (users.size === 0) {
					// Hack for better compat with < 0.4.2.
					this.log(
						"[getDocument] Server contains uninitialized doc — waiting for peer to upload.",
						users.size,
						retry,
						wait,
					);
					if (retry > 0) {
						this.timeProvider.setTimeout(() => {
							void this.getDocument(doc, retry - 1, wait * 2);
						}, wait);
					}
					return;
				}
				if (doc.text) {
					this.log(
						"[getDocument] local crdt has contents, but remote is empty",
					);
					void this.enqueueSync(doc);
					return;
				}
			}

			this.log("[getDocument] applying content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (doc.sharedFolder.syncStore.has(doc.path)) {
				void doc.sharedFolder.flush(doc, doc.text);
				this.log("[getDocument] flushed");
			}
		} catch (e: unknown) {
			// HTTP download failed (e.g., CWT tokens not accepted for HTTP endpoints).
			// Fall back to WebSocket sync for the document content.
			this.warn("[getDocument] HTTP download failed, falling back to WS sync:", (e as Error).message);
			try {
				const synced = await this.syncDocumentWebsocket(doc);
				if (synced && doc.sharedFolder.syncStore.has(doc.path)) {
					void doc.sharedFolder.flush(doc, doc.text);
					this.log("[getDocument] WS sync fallback successful, flushed to disk");
				}
			} catch (wsError: unknown) {
				this.error("[getDocument] WS sync fallback also failed:", wsError);
			}
			return;
		}
	}

	private async syncFile(file: SyncFile) {
		await file.sync();
	}

	private async getSyncFile(file: SyncFile) {
		await file.pull();
	}

	/**
	 * False when the document came back from this round without its body,
	 * which the queue counts as a failed sync rather than a finished one.
	 * Swallowing the answer here is how a fill that wrote nothing still
	 * reported every document done (#38).
	 */
	private async syncDocument(doc: Document | Canvas): Promise<boolean> {
		try {
			if (isDocument(doc) || isCanvas(doc)) {
				return await this.syncDocumentWebsocket(doc);
			}
			return true;
		} catch (e: unknown) {
			this.error("[syncDocument] sync threw for", doc.path, e);
			return false;
		}
	}

	subscribeToSync(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeSync.subscribe(callback);
	}

	subscribeToDownloads(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeDownloads.subscribe(callback);
	}

	subscribeToSyncGroups(
		callback: Subscriber<ObservableMap<SharedFolder, SyncGroup>>,
	): Unsubscriber {
		return this.syncGroups.subscribe(callback);
	}

	subscribeToProgress(callback: Subscriber<SyncProgress>): Unsubscriber {
		const handler = () => {
			callback(this.getOverallProgress());
		};

		const unsub1 = this.activeSync.subscribe(() => handler());
		const unsub2 = this.activeDownloads.subscribe(() => handler());
		const unsub3 = this.syncGroups.subscribe(() => handler());

		return () => {
			unsub1();
			unsub2();
			unsub3();
		};
	}

	/**
	 * Subscribes to progress updates for a specific shared folder
	 *
	 * @param sharedFolder The shared folder to monitor
	 * @param callback The function to call when progress changes
	 * @returns A function to unsubscribe
	 */
	subscribeToGroupProgress(
		sharedFolder: SharedFolder,
		callback: Subscriber<GroupProgress | null>,
	): Unsubscriber {
		return this.syncGroups.subscribe(() => {
			callback(this.getGroupProgress(sharedFolder));
		});
	}

	/**
	 * Pauses all sync and download queue processing
	 *
	 * This method temporarily halts processing of sync and download queues.
	 * The queues can be resumed by calling resume().
	 */
	pause(): void {
		this.isPaused = true;
	}

	/**
	 * Resumes sync and download queue processing
	 *
	 * This method resumes processing of sync and download queues after
	 * they have been paused.
	 */
	resume(): void {
		this.debug("starting");
		this.isPaused = false;
		void this.processSyncQueue();
		void this.processDownloadQueue();
	}
	start = () => this.resume();

	/**
	 * Gets the current status of sync and download queues
	 *
	 * @returns An object with queue statistics
	 */
	getQueueStatus(): {
		syncsQueued: number;
		syncsActive: number;
		downloadsQueued: number;
		downloadsActive: number;
		isPaused: boolean;
	} {
		return {
			syncsQueued: this.syncQueue.length,
			syncsActive: this.activeSync.size,
			downloadsQueued: this.downloadQueue.length,
			downloadsActive: this.activeDownloads.size,
			isPaused: this.isPaused,
		};
	}

	/**
	 * Destroys this instance and cleans up all resources
	 *
	 * This method cleans up all resources used by this instance,
	 * including rejecting pending promises, destroying observable
	 * collections, and clearing queues.
	 */
	destroy(): void {
		// Reject all pending sync promises
		for (const [guid, callback] of this.syncCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.syncCompletionCallbacks.delete(guid);
		}

		// Reject all pending download promises
		for (const [guid, callback] of this.downloadCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.downloadCompletionCallbacks.delete(guid);
		}

		// Destroy observable collections
		this.activeSync.destroy();
		this.activeDownloads.destroy();
		this.syncGroups.destroy();

		// Clear queues and tracking
		this.syncQueue = [];
		this.downloadQueue = [];
		this.inProgressSyncs.clear();
		this.inProgressDownloads.clear();
		this.loggedItems.clear();

		// Clean up references
		this.loginManager = null as unknown as LoginManager;
		this.timeProvider = null as unknown as TimeProvider;

		// Unsubscribe from all subscriptions
		this.subscriptions.forEach((off) => off());
	}
}
