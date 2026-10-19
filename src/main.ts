"use strict";

import { PLUGIN_ID, STORAGE_PREFIX } from "./pluginId";
import { adoptLegacyPlugin } from "./legacyPlugin";
import {
	TFolder,
	Notice,
	MarkdownView,
	normalizePath,
	MetadataCache,
	TFile,
	Vault,
	FileManager,
	requireApiVersion,
	Modal,
	moment,
	addIcon,
	setIcon,
	App,
	type PluginManifest,
} from "obsidian";
import { Platform } from "obsidian";

/** Internal Obsidian App properties not exposed in the public API */
interface ObsidianApp {
	appId: string;
	reloadRelay?: () => Promise<void>;
	plugins: {
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
		/**
		 * The ids switched on in this vault, as a `Set`. Undocumented, so it
		 * is typed as `unknown` and checked where it is read
		 * (`loadedPluginIds`) rather than believed here.
		 */
		enabledPlugins?: unknown;
		/** One entry per plugin installed, keyed by id. Undocumented too. */
		manifests?: unknown;
		/** Turns a plugin off and remembers it. Undocumented too. */
		disablePluginAndSave?(id: string): Promise<void>;
	};
	setting: {
		open(): Promise<void>;
		openTabById(id: string): Promise<void>;
	};
	internalPlugins?: {
		plugins?: {
			webviewer?: {
				enabled: boolean;
				instance?: {
					options: Record<string, unknown>;
				};
			};
		};
	};
	commands: {
		commands: Record<string, unknown>;
		editorCommands: Record<string, unknown>;
	};
	hotkeyManager: {
		removeDefaultHotkeys(id: string): boolean;
	};
}
import { relative } from "path-browserify";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import type { ShareScope } from "./vaultScope";
import { LiveViewManager } from "./LiveViews";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager, type LoginSettings } from "./LoginManager";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
} from "./debug";
import { getPatcher, Patcher } from "./Patcher";
import { registerKnapBeta } from "./knap/ObsidianKnap";
import { checkedCounts, checking, type KnapSync } from "./knap/KnapSync";
import type { KnapLink } from "./knap/KnapSync";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { RelayManager } from "./RelayManager";
import { DefaultTimeProvider, type TimeProvider } from "./TimeProvider";
import { auditTeardown } from "./observable/Observable";
import { Plugin } from "obsidian";

import {
	DifferencesView,
	VIEW_TYPE_DIFFERENCES,
} from "./differ/differencesView";
import { FeatureFlagDefaults, flag, type FeatureFlags } from "./flags";
import { FeatureFlagManager, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { IndexedDBAnalysisModal } from "./ui/IndexedDBAnalysisModal";

import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";
import { EndpointManager, type EndpointSettings } from "./EndpointManager";
import {
	DEFAULT_RELAY_ONPREM_SETTINGS,
	KNAP_SERVER_ID,
	type RelayOnPremSettings,
	type RelayOnPremServer,
	migrateRelayOnPremSettings,
	getDefaultServer,
	healthUrlForServer,
} from "./RelayOnPremConfig";
import { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";
import {
	oauthDeepLinkReceiver,
	OAUTH_CALLBACK_ACTION,
} from "./auth/OAuthDeepLinkReceiver";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { RelayOnPremShareClient, type FolderItem } from "./RelayOnPremShareClient";
import { RelayOnPremShareClientManager, type ShareWithServer } from "./RelayOnPremShareClientManager";
// ShareManagementModal only imports main.ts for its type, which erases at
// compile time, so there is no runtime cycle for a plain import to trip over.
// It was being pulled in with require() at three call sites instead.
import { ShareManagementModal } from "./ui/ShareManagementModal";
import { LocalStorage } from "./LocalStorage";
import {
	SYNC_DOT_NAMES,
	statusBarPaint,
	vaultReading,
	type VaultReading,
} from "./vaultStatus";
import { STILL, settle, type Burst } from "./quiet";
import {
	OFFLINE,
	PAUSED,
	PROBLEM,
	SIGNED_OUT,
	DOWNLOADING,
	INITIALIZING,
	SYNCING,
	UPLOADING,
	UP_TO_DATE,
	isMoving,
	syncCounts,
	syncProgress,
	type SyncWord,
} from "./syncStatus";
import {
	recallVault,
	rememberedVaultId,
	type RememberedVault,
} from "./vaultMemory";
import { reportFault, setFaultReporting } from "./faults";

interface DebugSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
	debugging: false,
};

/**
 * Whether the plugin reports its faults (ADR-0071): error type, component,
 * plugin version and platform, and nothing else. On by default, with the off
 * switch on the settings screen, because default-on with no exit is not a
 * privacy stance.
 */
export interface ReportingSettings {
	faultReporting: boolean;
}

const DEFAULT_REPORTING_SETTINGS: ReportingSettings = {
	faultReporting: true,
};

interface RelaySettings extends FeatureFlags, DebugSettings, ReportingSettings {
	sharedFolders: SharedFolderSettings[];
	endpoints: EndpointSettings;
	relayOnPrem: RelayOnPremSettings;
	/**
	 * Which cloud vault somebody pointed this one at (#64).
	 *
	 * Kept beside `sharedFolders` rather than read back out of it, because the
	 * share record is machinery several code paths rewrite and this is one
	 * fact a person supplied. `vaultMemory.ts` has the whole reasoning.
	 */
	vault: RememberedVault;
	/**
	 * The plugin version that last finished starting here. Read at the end of
	 * the next start: a difference means an update landed, and that is the
	 * moment somebody wants to hear whether everything still works, because
	 * an update that quietly broke sync and one that quietly worked used to
	 * look identical.
	 */
	lastRunVersion?: string;
	/**
	 * The rebuild's sign-in and link (docs/rebuild-plan.md phase 2 in
	 * knap-mcp-admin). Only a build with KNAP_SERVER_URL set ever reads or
	 * writes it; every ordinary build leaves it untouched.
	 */
	knap?: KnapLink | null;
}

const DEFAULT_SETTINGS: RelaySettings = {
	sharedFolders: [],
	endpoints: {},
	relayOnPrem: DEFAULT_RELAY_ONPREM_SETTINGS,
	vault: {},
	...FeatureFlagDefaults,
	...DEFAULT_DEBUG_SETTINGS,
	...DEFAULT_REPORTING_SETTINGS,
};

declare const GIT_TAG: string;

export default class Live extends Plugin {
	appId!: string;
	webviewerPatched = false;
	openModals: Modal[] = [];
	loadTime?: number;
	sharedFolders!: SharedFolders;
	vault!: Vault;
	notifier!: ObsidianNotifier;
	loginManager!: LoginManager;
	timeProvider!: TimeProvider;
	fileManager!: FileManager;
	tokenStore!: LiveTokenStore;
	interceptedUrls: Array<string | RegExp> = [];
	networkStatus!: NetworkStatus;
	backgroundSync!: BackgroundSync;
	folderNavDecorations!: FolderNavigationDecorations;
	relayManager!: RelayManager;
	settingsTab!: LiveSettingsTab;
	settings!: Settings<RelaySettings>;
	knapSync: KnapSync | null = null;
	private featureSettings!: NamespacedSettings<FeatureFlags>;
	private debugSettings!: NamespacedSettings<DebugSettings>;
	/** The fault-reporting switch (ADR-0071). Public: the settings screen toggles it. */
	public reportingSettings!: NamespacedSettings<ReportingSettings>;
	private folderSettings!: NamespacedSettings<SharedFolderSettings[]>;
	/**
	 * The cloud vault this device was told to sync (#64).
	 *
	 * One short record of its own, so a plugin update that loses the share
	 * cannot lose the answer with it. Read and written only through
	 * `rememberVault`, `forgetVault` and `restoreRememberedVault`.
	 */
	private vaultMemory!: NamespacedSettings<RememberedVault>;
	public loginSettings!: NamespacedSettings<LoginSettings>;
	public endpointSettings!: NamespacedSettings<EndpointSettings>;
	public relayOnPremSettings!: NamespacedSettings<RelayOnPremSettings>;
	public shareClient?: RelayOnPremShareClient;
	public shareClientManager?: RelayOnPremShareClientManager;
	public webSyncManager?: import("./WebSyncManager").WebSyncManager;
	public inboundFileDownloader?: import("./InboundFileDownloader").InboundFileDownloader;
	public inboundSyncPoller?: import("./InboundSyncPoller").InboundSyncPoller;
	/**
	 * Whether this vault is not syncing and is waiting for a person.
	 *
	 * Set by the settings screen, read by the corner of the window, so the two
	 * cannot describe one vault two ways: a vault waiting to be told which
	 * vault on Knap it belongs to (#42) reads Paused on both rather than Up to
	 * date on either.
	 */
	public vaultHeld = false;
	debug!: (...args: unknown[]) => void;
	log!: (...args: unknown[]) => void;
	warn!: (...args: unknown[]) => void;
	error!: (...args: unknown[]) => void;
	private _liveViews!: LiveViewManager;
	fileDiffMergeWarningKey = "file-diff-merge-warning";
	version = GIT_TAG;
	hashStore!: ContentAddressedFileStore;

	enableDebugging(save?: boolean) {
		setDebugging(true);
		console.warn("RelayInstances", RelayInstances);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: true,
			}));
		}
	}

	disableDebugging(save?: boolean) {
		setDebugging(false);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: false,
			}));
		}
	}

	toggleDebugging(save?: boolean): boolean {
		const setTo = !this.debugSettings.get().debugging;
		setDebugging(setTo);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: setTo,
			}));
		}
		return setTo;
	}

	buildApiUrl(path: string) {
		return this.loginManager.getEndpointManager().getApiUrl() + path;
	}

	/**
	 * Validate custom endpoints on startup if configured
	 */
	private async validateEndpointsOnStartup(
		endpointManager: EndpointManager,
	): Promise<void> {
		const settings = this.endpointSettings.get();

		// Skip if no active tenant configured
		if (!settings.activeTenantId || !settings.tenants?.length) {
			this.log("No active enterprise tenant configured, using defaults");
			return;
		}

		const activeTenant = settings.tenants.find(
			(t) => t.id === settings.activeTenantId,
		);
		if (!activeTenant) {
			this.log("Active tenant not found, using defaults");
			return;
		}

		this.log("Enterprise tenant configured, validating on startup...", {
			tenantId: activeTenant.id,
			tenantUrl: activeTenant.tenantUrl,
			tenantName: activeTenant.name,
		});

		try {
			// Use shorter timeout for startup validation to avoid blocking startup
			const result = await endpointManager.validateAndSetEndpoints(5000);

			if (result.success) {
				// Clear any previous validation errors on successful startup validation
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: undefined,
					_lastValidationAttempt: undefined,
				}));
				this.log("✓ Enterprise tenant validated and applied on startup", {
					licenseInfo: result.licenseInfo,
				});
			} else {
				this.error(
					"❌ Enterprise tenant validation failed on startup",
					result.error,
				);
				// Store the error for display in settings
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: result.error,
					_lastValidationAttempt: Date.now(),
				}));
				new Notice(
					`❌ Custom endpoints failed validation: ${result.error}`,
					8000,
				);
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.error("Startup endpoint validation error:", errorMessage);
			// Store the error for display in settings
			await this.endpointSettings.update((current) => ({
				...current,
				_lastValidationError: errorMessage,
				_lastValidationAttempt: Date.now(),
			}));
			new Notice(`❌ Endpoint validation error: ${errorMessage}`, 8000);
		}
	}
	async onload() {
		this.appId = (this.app as unknown as ObsidianApp).appId;
		const start = moment.now();
		RelayInstances.set(this, "plugin");
		this.timeProvider = new DefaultTimeProvider();
		this.register(() => {
			this.timeProvider.destroy();
		});

		const logFilePath = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/relay.log`,
		);

		initializeLogger(
			new ObsidianFileAdapter(this.app.vault),
			this.timeProvider,
			logFilePath,
			{
				maxFileSize: 5 * 1024 * 1024, // 5MB
				maxBackups: 3,
				disableConsole: false, // Disable console logging
			},
		);
		this.notifier = new ObsidianNotifier();

		this.debug = curryLog("[Pantalytics]", "debug");
		this.log = curryLog("[Pantalytics]", "log");
		this.warn = curryLog("[Pantalytics]", "warn");
		this.error = curryLog("[Pantalytics]", "error");

		// Before the settings load, so a device moving from the old id
		// starts with its own token and link (ADR-0103).
		// Silent: nobody outside Pantalytics ran the old plugin (ADR-0107).
		await adoptLegacyPlugin(
			this.app.vault.adapter,
			(this.app as unknown as ObsidianApp).plugins,
			this.app.vault.configDir,
		);

		this.settings = new Settings<RelaySettings>(this, DEFAULT_SETTINGS);
		await this.settings.load();

		// The rebuild's beta switch: a no-op unless the build carries a
		// server address (src/knap/ObsidianKnap.ts).
		//
		// Wrapped, because this runs early in onload and everything after it
		// depends on onload finishing. A first version of the beta's settings
		// tab threw here, and what a person saw was the ribbon icon gone --
		// registered eighty lines further down, and never reached. A half-built
		// beta layer is worth a notice; it is not worth the plugin.
		try {
			this.knapSync = registerKnapBeta(this);
		} catch (error) {
			this.knapSync = null;
			console.error("[Pantalytics] the beta layer failed to start", error);
			new Notice("Pantalytics: the beta layer failed to start. The rest of the plugin is fine.");
		}

		// Migrate relay-onprem settings from legacy single-server format to multi-server
		const rawRelayOnPremSettings = this.settings.get().relayOnPrem;
		const migration = migrateRelayOnPremSettings(rawRelayOnPremSettings);
		if (migration.changed) {
			await this.settings.update((settings) => ({
				...settings,
				relayOnPrem: migration.settings,
			}));
		}
		// If an existing server was adopted as the well-known Knap server, migrate
		// its localStorage auth key
		// and update all shared folder settings that reference the old server ID
		if (migration.renamedServerId) {
			const oldId = migration.renamedServerId;
			// Must match RelayOnPremAuthStore.getStorageKey()'s format, which is
			// keyed by appId (stable across vault renames), not vault display name.
			const prefix = `${STORAGE_PREFIX}_onprem_auth_`;
			// The prefix was part of the rename, so a key written before it says
			// knap-sync on both halves. Read the old shape as well as the old id,
			// or the one device that has been signed in the longest is the one
			// that gets signed out.
			const legacyPrefixes = [prefix, "knap-sync_onprem_auth_"];
			const newKey = `${prefix}${this.appId}_${KNAP_SERVER_ID}`;
			try {
				if (!window.localStorage.getItem(newKey)) {
					for (const legacy of legacyPrefixes) {
						const oldKey = `${legacy}${this.appId}_${oldId}`;
						const oldData = window.localStorage.getItem(oldKey);
						if (oldData) {
							window.localStorage.setItem(newKey, oldData);
							window.localStorage.removeItem(oldKey);
							break;
						}
					}
				}
			} catch {
				// localStorage may not be available during startup
			}
			// Migrate onpremServerId in shared folder settings
			const currentSettings = this.settings.get();
			const folders = currentSettings.sharedFolders;
			if (folders?.length) {
				let folderChanged = false;
				const updated = folders.map((f) => {
					if (f.onpremServerId === oldId) {
						folderChanged = true;
						return { ...f, onpremServerId: KNAP_SERVER_ID };
					}
					return f;
				});
				if (folderChanged) {
					await this.settings.update((s) => ({ ...s, sharedFolders: updated }));
				}
			}
		}

		const settingsBase = this.settings as unknown as Settings<unknown>;
		this.featureSettings = new NamespacedSettings(settingsBase, "(enable*)");
		this.debugSettings = new NamespacedSettings(settingsBase, "(debugging)");
		this.reportingSettings = new NamespacedSettings(settingsBase, "(faultReporting)");
		// Runs once at subscribe time as well, so the reporter starts in
		// whatever state the setting was left in. Absent means on: the switch
		// is default-on and an install that predates it has never said no.
		this.register(
			this.reportingSettings.subscribe((settings) => {
				setFaultReporting(settings.faultReporting !== false);
			}),
		);
		this.folderSettings = new NamespacedSettings(
			settingsBase,
			"sharedFolders",
		);
		this.vaultMemory = new NamespacedSettings(settingsBase, "vault");
		this.loginSettings = new NamespacedSettings(settingsBase, "login");
		this.endpointSettings = new NamespacedSettings(settingsBase, "endpoints");
		this.relayOnPremSettings = new NamespacedSettings(settingsBase, "relayOnPrem");

		const flagManager = FeatureFlagManager.getInstance();
		flagManager.setSettings(this.featureSettings);

		this.settingsTab = new LiveSettingsTab(this.app, this);

		// Our own ribbon icon: a note kept in step with a server
		addIcon(PLUGIN_ID, `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 44.4a32 32 0 0 1 63 0"/><path d="M87.3 31.2 81.5 44.4 71.5 34"/><path d="M81.5 55.6a32 32 0 0 1-63 0"/><path d="M12.7 68.8 18.5 55.6 28.5 66"/><circle cx="50" cy="50" r="7" fill="currentColor" stroke="none"/></svg>`);
		this.addRibbonIcon(PLUGIN_ID, "Pantalytics", () => {
			void this.openSettings();
		});

		this.register(
			this.debugSettings.subscribe((settings) => {
				if (settings.debugging) {
					this.enableDebugging();
					this.removeCommand("enable-debugging");
					this.addCommand({
						id: "toggle-feature-flags",
						name: "Show feature flags",
						callback: () => {
							const modal = new FeatureFlagToggleModal(this.app, () => {
								void this.reload();
							});
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "show-debug-info",
						name: "Show debug info",
						callback: () => {
							const modal = new DebugModal(this.app, this);
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "analyze-indexeddb",
						name: "Analyze database",
						callback: () => {
							const modal = new IndexedDBAnalysisModal(this.app, this);
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "disable-debugging",
						name: "Disable debugging",
						callback: () => {
							this.disableDebugging(true);
						},
					});
				} else {
					this.removeCommand("toggle-feature-flags");
					this.removeCommand("show-debug-info");
					this.removeCommand("disable-debugging");
					this.addCommand({
						id: "enable-debugging",
						name: "Enable debugging",
						callback: () => {
							this.enableDebugging(true);
						},
					});
				}
			}),
		);

		// Store app reference for reload function (avoid window.app per Obsidian guidelines)
		const appRef = this.app as unknown as ObsidianApp;
		appRef.reloadRelay = async () => {
			await appRef.plugins.disablePlugin(PLUGIN_ID);
			await appRef.plugins.enablePlugin(PLUGIN_ID);
		};

		this.addCommand({
			id: "reload",
			name: "Reload plugin",
			callback: async () => await (this.app as unknown as ObsidianApp).reloadRelay?.(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				void this.openSettings();
			},
		});


		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.hashStore = new ContentAddressedFileStore(this.appId);

		// Initialize and validate endpoints before creating LoginManager
		const endpointManager = new EndpointManager(this.endpointSettings);
		await this.validateEndpointsOnStartup(endpointManager);

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.appId,
			this.openSettings.bind(this),
			this.timeProvider,
			this.patchWebviewer.bind(this),
			this.loginSettings,
			endpointManager,
			this.relayOnPremSettings.get(),
			this.relayOnPremSettings,
		);
		this.relayManager = new RelayManager(this.loginManager);
		this.sharedFolders = new SharedFolders(
			this.relayManager,
			this.vault,
			this._createSharedFolder.bind(this),
			this.folderSettings,
			() => {
				this.forgetVault();
			},
		);

		// Initialize relay-onprem token provider and share client if enabled
		const relayOnPremSettings = this.relayOnPremSettings.get();
		let relayOnPremTokenProvider: RelayOnPremTokenProvider | undefined;
		const defaultServer = getDefaultServer(relayOnPremSettings);
		// TR-32: tracks which URL relayOnPremTokenProvider is currently pointed
		// at, so the settings subscription below can detect when the default
		// server's controlPlaneUrl changes (the provider is otherwise long-lived
		// and never re-reads settings on its own).
		let tokenProviderControlPlaneUrl = defaultServer?.controlPlaneUrl;

		if (relayOnPremSettings.enabled && defaultServer) {
			// Lazy auth provider — defers to loginManager at call time.
			// Needed because OAuth auth provider may not be available at plugin load.
			const lazyAuthProvider: IAuthProvider = {
				isLoggedIn: () => this.loginManager.getAuthProvider()?.isLoggedIn() ?? false,
				getCurrentUser: () => this.loginManager.getAuthProvider()?.getCurrentUser(),
				getToken: () => this.loginManager.getAuthProvider()?.getToken(),
				getValidToken: async () => {
					const provider = this.loginManager.getAuthProvider();
					return provider ? await provider.getValidToken() : undefined;
				},
				loginWithPassword: () => Promise.reject(new Error("Use loginManager directly")),
				loginWithOAuth2: () => Promise.reject(new Error("Use loginManager directly")),
				refreshToken: () => {
				const provider = this.loginManager.getAuthProvider();
				if (!provider) return Promise.reject(new Error("No auth provider available"));
				return provider.refreshToken();
			},
				logout: () => Promise.reject(new Error("Use loginManager directly")),
				isTokenValid: () => this.loginManager.getAuthProvider()?.isTokenValid() ?? false,
			};

			relayOnPremTokenProvider = new RelayOnPremTokenProvider({
				controlPlaneUrl: defaultServer.controlPlaneUrl,
				authProvider: lazyAuthProvider,
			});

			// Initialize share client for relay-onprem mode (backward compatibility)
			this.shareClient = new RelayOnPremShareClient(
				defaultServer.controlPlaneUrl,
				async () => {
					const provider = this.loginManager.getAuthProvider();
					return provider ? await provider.getValidToken() : undefined;
				},
			);
		}

		// Wait for auth restoration before using auth state, but not forever.
		// Restoring an expired session goes over the network with retries and
		// no bound of its own, and everything a person can see, the settings
		// tab, the status bar, the editor bindings, sits after this line. On a
		// machine that has just come back online, the plugin looked
		// uninstalled for as long as the control plane kept it waiting.
		// Auth restore keeps running behind this; the login listener picks the
		// session up whenever it lands.
		await Promise.race([
			this.loginManager.waitForRestore(),
			new Promise<void>((resolve) => {
				this.timeProvider.setTimeout(resolve, 10_000);
			}),
		]);

		// Initialize multi-server share client manager
		if (relayOnPremSettings.enabled && relayOnPremSettings.servers.length > 0) {
			const multiServerAuthManager = this.loginManager.getMultiServerAuthManager();
			if (multiServerAuthManager) {
				this.shareClientManager = new RelayOnPremShareClientManager(
					multiServerAuthManager,
					relayOnPremSettings.servers,
				);
			}
		}

		// Initialize WebSyncManager for auto-sync (v1.8.1)
		if (this.shareClientManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(
				this.vault,
				this.shareClientManager
			);
		}

		// Initialize InboundFileDownloader for sync-artifact inbound sync (v1.9)
		if (this.vault && this.shareClientManager && this.webSyncManager) {
			const { InboundFileDownloader } = await import("./InboundFileDownloader");
			// Persisted across restarts (TR-02, #307f52bf) — see InboundFileDownloader's
			// constructor doc for why an in-memory-only manifest is unsafe.
			const hashManifestStore = new LocalStorage<Record<string, string>>(
				"InboundSyncHashManifest/" + vaultName,
				this.app,
			);
			this.inboundFileDownloader = new InboundFileDownloader(
				this.vault,
				this.shareClientManager,
				this.webSyncManager,
				hashManifestStore,
				// Where a share lives here, which for a vault share is the
				// root, whatever name it carries on the server.
				(shareId: string) => {
					const folder = this.sharedFolders.find(
						(f) => f.guid === shareId && f.isVaultScope,
					);
					return folder ? "" : undefined;
				},
			);
		}

		// Initialize InboundSyncPoller (v1.9)
		if (this.shareClientManager && this.webSyncManager && this.inboundFileDownloader) {
			const { InboundSyncPoller } = await import("./InboundSyncPoller");
			// Persisted across restarts (TR-02, #307f52bf) — see InboundSyncPoller's
			// constructor doc for why an in-memory-only watermark is unsafe.
			const lastUpdatedAtStore = new LocalStorage<string>(
				"InboundSyncLastUpdatedAt/" + vaultName,
				this.app,
			);
			this.inboundSyncPoller = new InboundSyncPoller(
				this.timeProvider,
				this.shareClientManager,
				this.webSyncManager,
				this.inboundFileDownloader,
				undefined,
				lastUpdatedAtStore,
			);
		}

		// Add status bar item for Relay On-Prem (v1.8.2)
		if (relayOnPremSettings.enabled) {
			this.addRelayStatusBarItem();
		}

		this.tokenStore = new LiveTokenStore(
			this.loginManager,
			this.timeProvider,
			vaultName,
			3,
			relayOnPremTokenProvider,
			this.app,
		);

		this.networkStatus = new NetworkStatus(
			this.timeProvider,
			healthUrlForServer(defaultServer),
		);

		this.backgroundSync = new BackgroundSync(
			this.loginManager,
			this.timeProvider,
			this.sharedFolders,
		);

		if (!this.loginManager.setup()) {
			// In relay-onprem mode, setup() returns false because auth is handled
			// asynchronously via waitForRestore(). Only show notice for non-relay-onprem.
			if (!this.loginManager.isRelayOnPremMode()) {
				new Notice("Please sign in to use relay");
			}
		}

		this.app.workspace.onLayoutReady(() => {
			this.sharedFolders.load();
			// And the vault somebody picked, if the load did not bring it back
			// (#64). Immediately after the load and before anything reads the
			// folders, so nothing downstream ever sees a vault that syncs as a
			// vault that has not been set up.
			this.restoreRememberedVault();


			this._liveViews = new LiveViewManager(
				this.app,
				this.sharedFolders,
				this.loginManager,
				this.networkStatus,
			);

			// NOTE: Extensions list should be loaded once and then mutated.
			// this.app.workspace.updateOptions(); must be called to apply changes.
			this.registerEditorExtension(this._liveViews.extensions);

			this.register(
				this.loginManager.on(() => {
					if (this.loginManager.loggedIn) {
						this._onLogin();
					} else {
						this._onLogout();
					}
				}),
			);

			// If user is already logged in after auth restore, trigger login flow now.
			// This handles the case where auth restored before onLayoutReady fired,
			// so the login listener missed the state change notification.
			if (this.loginManager.loggedIn) {
				this._onLogin();
			}

			this.tokenStore.start();

			// Sync shareClientManager when relay-onprem settings change
			let prevServerIds = new Set(
				this.relayOnPremSettings.get().servers?.map((s: RelayOnPremServer) => s.id) || []
			);
			this.register(
				this.relayOnPremSettings.subscribe((settings) => {
					const currentServers = settings.servers || [];
					const currentIds = new Set(currentServers.map((s: RelayOnPremServer) => s.id));

					// New servers added
					for (const server of currentServers) {
						if (!prevServerIds.has(server.id)) {
							void this.ensureShareClientManager();
							this.shareClientManager?.addServer(server);
						}
					}
					// Removed servers
					for (const id of prevServerIds) {
						if (!currentIds.has(id)) {
							this.shareClientManager?.removeServer(id);
						}
					}
					// Updated servers (URL or name changed)
					for (const server of currentServers) {
						if (prevServerIds.has(server.id) && this.shareClientManager) {
							this.shareClientManager.updateServer(server);
						}
					}
					prevServerIds = currentIds;

					// TR-32: relayOnPremTokenProvider is created once at load and
					// held for the plugin's lifetime by tokenStore — the loop above
					// only keeps shareClientManager in sync, so a default-server URL
					// edit left /tokens/relay requests going to the old host until
					// Obsidian restarted. Re-point it whenever the resolved default
					// server's URL changes.
					const newDefaultServer = getDefaultServer(settings);
					if (
						newDefaultServer &&
						newDefaultServer.controlPlaneUrl !== tokenProviderControlPlaneUrl
					) {
						if (relayOnPremTokenProvider) {
							relayOnPremTokenProvider.updateControlPlaneUrl(newDefaultServer.controlPlaneUrl);
						}
						// TR-26: networkStatus's health-check URL is derived from the
						// same default-server controlPlaneUrl — re-point it too, or a
						// server-URL edit leaves offline/online detection pointed at
						// the old (or no) host until Obsidian restarts.
						this.networkStatus.updateUrl(healthUrlForServer(newDefaultServer));
						tokenProviderControlPlaneUrl = newDefaultServer.controlPlaneUrl;
					}
				})
			);

			if (!Platform.isIosApp) {
				// We can't run network status on iOS or it will always be offline.
				this.networkStatus.addEventListener("offline", () => {
					this.tokenStore.stop();
					this.sharedFolders.forEach((folder) => folder.disconnect());
					this._liveViews.goOffline();
				});
				this.networkStatus.addEventListener("online", () => {
					this.tokenStore.start();
					this.relayManager.subscribe();
					void this.relayManager.update();
					this._liveViews.goOnline();
				});
				this.networkStatus.start();
			}

			this.registerView(
				VIEW_TYPE_DIFFERENCES,
				(leaf) => new DifferencesView(leaf),
			);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFolder) {
						const folder = this.sharedFolders.find(
							(sharedFolder) => sharedFolder.path === file.path,
						);
						if (!folder) {
							// Nothing to offer. A vault syncs whole (ADR-0042), so every
							// folder in it is already syncing and the item that used to
							// sit here would be asking somebody to sync a folder twice.
							// Deleting or renaming a folder is how it stops or moves,
							// the way it works in every other sync.
							return;
						}
						if (folder.relayId) {
							// The item that used to sit here opened upstream's relay
							// screen for a relay id our shares do not have, so it
							// landed on the settings screen by accident. There is one
							// server and nothing to configure about it (ADR-0033).
							menu.addItem((item) => {
								item
									.setTitle("Pantalytics: folder settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId, undefined, folder.guid).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
							menu.addItem((item) => {
								item
									.setTitle(
										folder.connected ? "Pantalytics: disconnect" : "Pantalytics: connect",
									)
									.setIcon("satellite")
									.onClick(() => {
										if (folder.connected) {
											folder.shouldConnect = false;
											folder.disconnect();
										} else {
											folder.shouldConnect = true;
											void folder.connect();
										}
										void this._liveViews.refresh("folder connection toggle");
									});
							});
						} else {
							menu.addItem((item) => {
								item
									.setTitle("Pantalytics: folder settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId, undefined, folder.guid).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
						}
						if (folder.relayId && folder.connected) {
							menu.addItem((item) => {
								item
									.setTitle("Pantalytics: sync")
									.setIcon("folder-sync")
									.onClick(async () => {
										void folder.netSync();
										// Also update web_folder_items if share is web-published
										if (this.webSyncManager && this.shareClientManager && folder.guid) {
											try {
												const serverId = folder.settings?.onpremServerId;
												if (serverId) {
													const share = await this.shareClientManager.getShare(serverId, folder.guid);
													if (share?.web_published) {
														await this.webSyncManager.syncFolderStructureToWeb(
															folder.path, serverId, folder.guid
														);
													}
												}
											} catch {
												// Web sync is best-effort, don't block CRDT sync
											}
										}
									});
							});
						}
					} else if (file instanceof TFile) {
						const folder = this.sharedFolders.lookup(file.path);
						const ifile = folder?.getFile(file);
						if (ifile && isSyncFile(ifile)) {
							menu.addItem((item) => {
								item
									.setTitle("Pantalytics: download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pull();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.debugSettings.get().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Pantalytics: verify upload")
										.setIcon("search-check")
										.onClick(async () => {
											const present = await ifile.verifyUpload();
											new Notice(
												`${ifile.name} ${present ? "on server" : "missing from server"}`,
											);
										});
								});
							}
							menu.addItem((item) => {
								item
									.setTitle("Pantalytics: upload")
									.setIcon("cloud-upload")
									.onClick(async () => {
										await ifile.push(true);
										const present = await ifile.verifyUpload();
										new Notice(
											`${present ? "File uploaded:" : "File upload failed:"} ${ifile.name}`,
										);
									});
							});
						}
					}
				}),
			);
			const lastRunVersion = this.settings.get().lastRunVersion;
			try {
				this.setup();
			} catch (e) {
				// A start that died halfway used to look exactly like a start
				// that worked: the ribbon icon is there either way, and the
				// parts that did not come up are the parts that would have
				// said so.
				this.error("setup failed", e);
				reportFault("startup", e);
				new Notice(
					"Pantalytics could not finish starting, so sync may not be running. Restart Obsidian to try again. The log in the plugin folder has the details.",
					15000,
				);
				return;
			}
			void this._liveViews.refresh("init");
			this.loadTime = moment.now() - start;
			this.announceUpdate(lastRunVersion);

		});
	}

	/**
	 * Say that an update landed, and what the vault is doing under the new
	 * build. The one moment somebody actively wonders whether everything
	 * still works is right after an update, and up to now the plugin said
	 * nothing at exactly that moment: an update that quietly broke sync and
	 * one that quietly worked looked identical.
	 *
	 * Silent for a fresh install and for an ordinary restart of the same
	 * version. The delay gives the folders a moment to mount and connect, so
	 * the notice reports what the vault is doing rather than what it has not
	 * started yet.
	 */
	private announceUpdate(lastRunVersion: string | undefined) {
		const current = this.manifest.version;
		if (lastRunVersion === current) {
			return;
		}
		void this.settings.update((settings) => ({
			...settings,
			lastRunVersion: current,
		}));
		if (!lastRunVersion) {
			// A fresh install, or the first run of the build that starts
			// keeping this record. Nothing changed under anybody.
			return;
		}
		this.timeProvider.setTimeout(() => {
			const reading = this.readVaultStatus();
			const lines: Record<SyncWord, string> = {
				// The first pass over a vault that has just been linked. The
				// one moving word whose sentence asks for something, because
				// closing Obsidian in the middle of this one leaves the vault
				// half here (ADR-0090).
				[INITIALIZING]: "Your vault is filling up. Leave Obsidian open.",
				[SYNCING]: "Your vault is syncing.",
				// One sentence each, because the after-update notice is the
				// one place the word is read as a whole sentence rather than
				// as a label beside a number.
				[UPLOADING]: "Your vault is uploading.",
				[DOWNLOADING]: "Your vault is downloading.",
				[UP_TO_DATE]: "Your vault is up to date.",
				[PAUSED]: "Sync is paused on this device.",
				[OFFLINE]: "Pantalytics is out of reach. Your notes are safe here.",
				[SIGNED_OUT]: "Sign in to resume sync.",
				[PROBLEM]: "Something could not sync. Open Pantalytics in settings.",
			};
			new Notice(`Pantalytics updated to ${current}. ${lines[reading.word]}`);
		}, 3000);
	}

	async reload() {
		await (this.app as unknown as ObsidianApp).reloadRelay?.();
	}

	private _createSharedFolder(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
		scope: ShareScope = "folder",
	): SharedFolder {
		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		// The scope goes on disk with the rest of it, and until 1.12.4 it did
		// not: this function built a settings object carrying it and then
		// wrote a different one. Nothing else ever writes the field, so every
		// record on disk said folder, and `SharedFolders._load` rebuilt the
		// vault share as a folder share at the path "" on the next start. The
		// memory of which cloud vault this is (#64) then put the real one back
		// on the way past, which is why this survived: the vault came back
		// because a fallback caught it, not because the record was right.
		void folderSettings.update((current) => {
			return {
				...current,
				path,
				guid,
				scope,
				...(relayId ? { relay: relayId } : {}),
				...{
					sync: current.sync ? current.sync : SyncSettingsManager.defaultFlags,
				},
			};
		}, true);

		const folder = new SharedFolder(
			this.appId,
			guid,
			path,
			this.loginManager,
			this.vault,
			this.fileManager,
			this.tokenStore,
			this.relayManager,
			this.hashStore,
			this.backgroundSync,
			folderSettings,
			this.app,
			relayId,
			awaitingUpdates,
			scope,
		);
		return folder;
	}

	private async loadRelayOnPremShares() {
		const log = curryLog("[RelayOnPrem]", "log");
		const err = curryLog("[RelayOnPrem]", "error");

		// A beta build talks to the rebuilt server and to nothing else. Left
		// on, this reaches the control plane of the stack that build exists to
		// replace, lists its shares as "cloud vaults" beside the real ones,
		// and -- worse than confusing -- starts syncing them into whatever
		// vault the beta is installed in.
		if (this.knapSync) {
			log("Beta build: not loading anything from the control plane.");
			return;
		}

		try {
			log("Loading existing shares from control plane...");

			// Use multi-server manager if available, otherwise fall back to single client
			if (this.shareClientManager) {
				// Multi-server mode: load from all servers
				const allShares = await this.shareClientManager.getAllSharesFlat();
				log(`Found ${allShares.length} shares across all servers`);

				for (const share of allShares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.sharedFolders.find(
							(sf) => sf.guid === share.id
						);
						const byPath = !byGuid ? this.sharedFolders.find(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						// A vault share is mounted at the vault root with scope
						// "vault", and the migration below rebuilds a share from
						// the control plane's own path and the default scope --
						// which for a vault share is a folder share at a path
						// that does not exist on this device, after deleting the
						// record that said otherwise. That is one of the ways the
						// vault selection went missing across an update (#64), so
						// a share already covering the whole vault is left alone.
						if (existing?.isVaultScope) {
							if (!existing.connected) {
								log(`Connecting the vault share ${share.id}`);
								void existing.connect();
							}
						} else if (existing && (existing.guid !== share.id || !existing.relayId)) {
							// Migrate: guid mismatch or missing relayId — recreate
							log(`Migrating SharedFolder ${share.path} (guid: ${existing.guid} → ${share.id})`);
							this.sharedFolders.delete(existing);
							const sharedFolder = this.sharedFolders.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (sharedFolder && sharedFolder.settings) {
								sharedFolder.settings.onpremServerId = share.serverId;
							}
						} else if (!existing) {
							// A share on the account this device has no record of.
							// The only thing that ever qualified it was a local
							// folder whose name matched, which is a name collision
							// standing in for a decision -- the same class of fault
							// as #71, where one local vault ended up holding another
							// cloud vault's tree. A vault that is linked syncs whole
							// (ADR-0043) and has nothing to gain from a folder share
							// appearing beside it, so nothing is auto-created here
							// once a link exists.
							if (this.sharedFolders.items().some((f) => f.isVaultScope)) {
								log(`Ignoring "${share.path}": this vault is already linked to a cloud vault`);
								continue;
							}
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = this.app.vault.getAbstractFileByPath(share.path);
							if (vaultFolder && vaultFolder instanceof TFolder) {
								const sharedFolder = this.sharedFolders.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (sharedFolder && sharedFolder.settings) {
									sharedFolder.settings.onpremServerId = share.serverId;
								}
								log(`Created SharedFolder for ${share.path} on server ${share.serverId}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.connected) {
							// Folder exists with correct guid+relayId but not connected
							log(`Connecting SharedFolder ${share.path}`);
							void existing.connect();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								share.serverId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path} on server ${share.serverId}`);
						}
					}

					// Register all folder shares for inbound polling (v1.9)
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.inboundSyncPoller.registerShare(share.id, share.serverId);
						log(`Registered inbound poller for folder ${share.path} on server ${share.serverId}`);
					}
				}

				// Deferred initial full-sync for stale auto-sync folder shares (v1.1.18)
				const staleAutoSyncShares = allShares.filter(s => {
					if (!s.web_published || s.kind !== "folder" || s.web_sync_mode !== "auto") return false;
					if (!s.web_content_updated_at) return true;
					return Date.now() - new Date(s.web_content_updated_at).getTime() > 6 * 60 * 60 * 1000;
				});
				if (staleAutoSyncShares.length > 0) {
					log(`Scheduling initial full-sync for ${staleAutoSyncShares.length} stale auto-sync shares`);
					window.setTimeout(() => { void this._initialFullSync(staleAutoSyncShares); }, 15_000);
				}
			} else if (this.shareClient) {
				// Single-server mode (legacy)
				const shares = await this.shareClient.listShares();
				log(`Found ${shares.length} shares`);

				// Get default server ID
				const relayOnPremSettings = this.relayOnPremSettings.get();
				const defaultServerId = relayOnPremSettings.defaultServerId ||
					(relayOnPremSettings.servers.length > 0 ? relayOnPremSettings.servers[0].id : "default");

				for (const share of shares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.sharedFolders.find(
							(sf) => sf.guid === share.id
						);
						const byPath = !byGuid ? this.sharedFolders.find(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						// A vault share is mounted at the vault root with scope
						// "vault", and the migration below rebuilds a share from
						// the control plane's own path and the default scope --
						// which for a vault share is a folder share at a path
						// that does not exist on this device, after deleting the
						// record that said otherwise. That is one of the ways the
						// vault selection went missing across an update (#64), so
						// a share already covering the whole vault is left alone.
						if (existing?.isVaultScope) {
							if (!existing.connected) {
								log(`Connecting the vault share ${share.id}`);
								void existing.connect();
							}
						} else if (existing && (existing.guid !== share.id || !existing.relayId)) {
							// Migrate: guid mismatch or missing relayId — recreate
							log(`Migrating SharedFolder ${share.path} (guid: ${existing.guid} → ${share.id})`);
							this.sharedFolders.delete(existing);
							const sharedFolder = this.sharedFolders.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (sharedFolder && sharedFolder.settings) {
								sharedFolder.settings.onpremServerId = defaultServerId;
							}
						} else if (!existing) {
							// A share on the account this device has no record of.
							// The only thing that ever qualified it was a local
							// folder whose name matched, which is a name collision
							// standing in for a decision -- the same class of fault
							// as #71, where one local vault ended up holding another
							// cloud vault's tree. A vault that is linked syncs whole
							// (ADR-0043) and has nothing to gain from a folder share
							// appearing beside it, so nothing is auto-created here
							// once a link exists.
							if (this.sharedFolders.items().some((f) => f.isVaultScope)) {
								log(`Ignoring "${share.path}": this vault is already linked to a cloud vault`);
								continue;
							}
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = this.app.vault.getAbstractFileByPath(share.path);
							if (vaultFolder && vaultFolder instanceof TFolder) {
								const sharedFolder = this.sharedFolders.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (sharedFolder && sharedFolder.settings) {
									sharedFolder.settings.onpremServerId = defaultServerId;
								}
								log(`Created SharedFolder for ${share.path}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.connected) {
							// Folder exists with correct guid+relayId but not connected
							log(`Connecting SharedFolder ${share.path}`);
							void existing.connect();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								defaultServerId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path}`);
						}
					}

					// Register all folder shares for inbound polling (v1.9)
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.inboundSyncPoller.registerShare(share.id, defaultServerId);
						log(`Registered inbound poller for folder ${share.path}`);
					}
				}
			} else {
				log("No share client available, skipping share load");
				return;
			}

			// Start inbound poller after all shares registered (v1.9)
			this.inboundSyncPoller?.start();

			// Refresh visual indicators
			this.folderNavDecorations?.quickRefresh();
			log("Relay-onprem shares loaded");
		} catch (error: unknown) {
			err("Failed to load relay-onprem shares:", error);
		}
	}

	/**
	 * The Knap item in the status bar.
	 *
	 * The icon carries the state, so the ordinary case is a green mark in the
	 * corner and nothing to do. Clicking it opens the settings screen, and
	 * that is the whole of it: there used to be a menu with Sync vault and
	 * Sync this file above it, and a button that tells a sync layer to do what
	 * it already does adds a decision without adding an outcome.
	 *
	 * While notes are moving the count sits next to the icon (#41), and the bar
	 * sits after it. This is the machine doing the work, and somebody who has
	 * just pointed Knap at a few thousand notes should not have to open a web
	 * page to find out how far it has got: the count says how far in notes and
	 * the bar says how far at a glance, which is the one a person reads while
	 * they are doing something else.
	 */
	/** What the corner is saying, which lags what the vault is doing. */
	private corner: Burst = STILL;

	private addRelayStatusBarItem() {
		const statusBarItem = this.addStatusBarItem();
		statusBarItem.addClass("relay-onprem-statusbar");
		// Use the same registered icon as the ribbon
		const iconEl = statusBarItem.createSpan({ cls: "relay-status-icon" });
		setIcon(iconEl, PLUGIN_ID);
		const countEl = statusBarItem.createSpan({ cls: "relay-status-count" });
		// The bar, and nothing for a screen reader to read: the tooltip on the
		// item already says the word and the count, and a second voice for the
		// same fact is one interruption too many in a corner somebody is not
		// looking at.
		const trackEl = statusBarItem.createSpan({ cls: "relay-status-track" });
		trackEl.setAttribute("aria-hidden", "true");
		const fillEl = trackEl.createEl("i");
		statusBarItem.setAttribute("data-tooltip-position", "top");
		statusBarItem.addClass("evc-cursor-pointer");

		const paint = () =>
			this.paintRelayStatus(statusBarItem, iconEl, countEl, trackEl, fillEl);
		paint();
		// Nothing here is a subscription: the share comes and goes and its
		// provider changes state without telling anybody, so the corner reads
		// it rather than waiting to be told. It is a handful of numbers a tick.
		//
		// A second, which is what the settings screen ticks at, and for the
		// same reason: a bar is the thing somebody watches during a first sync
		// and one standing still reads as stuck. The tick does not cost what it
		// looks like it costs, because the one expensive number behind it, the
		// file list this device is missing, is cached for a second and a half
		// inside the folder (`SharedFolder.INBOUND_TTL_MS`).
		this.registerInterval(window.setInterval(paint, 1000));

		statusBarItem.addEventListener("click", () => {
			paint();
			void this.openSettings("/relay-onprem");
		});
	}

	/**
	 * Write down the cloud vault somebody just picked (#64).
	 *
	 * Called the moment a vault is joined or made, beside the share record
	 * rather than instead of it. A person answers this question once.
	 */
	public rememberVault(vault: RememberedVault): void {
		// Replaced whole, never merged into. Merging is how the record came to
		// hold one cloud vault's id under another cloud vault's name (#71): the
		// caller that only knows the id passed the id alone, and the name of
		// whatever was linked before stayed sitting beside it. A field the
		// caller cannot supply is better absent than wrong.
		void this.vaultMemory.set({
			id: vault.id,
			name: vault.name,
			serverId: vault.serverId,
			// Which local vault this is, alongside which cloud vault it syncs.
			// The pair is the record; see `vaultMemory.ts`.
			localId: this.appId,
		});
	}

	/**
	 * Forget it, because this device has stopped syncing that vault.
	 *
	 * The one thing that must clear the memory, and the only thing that may:
	 * without it, a share deliberately taken off would be put back by the next
	 * load, which is the opposite of the fault this memory exists for. Wired
	 * to `SharedFolders.delete`, so it covers every way a vault share comes
	 * off rather than the buttons somebody remembered to hook it up to.
	 */
	public forgetVault(): void {
		if (!this.vaultMemory) return;
		void this.vaultMemory.delete();
	}

	/**
	 * Put the remembered vault back, if the share record did not survive (#64).
	 *
	 * Runs after every `sharedFolders.load()` and again when the settings
	 * screen opens, and does nothing at all in the ordinary case where the
	 * share came back the way it was left. It costs no request: mounting a
	 * share is local, and what it mounts is exactly what joining a vault
	 * mounts -- the vault root, at vault scope, against the remembered id.
	 *
	 * It also fills the memory in from what is mounted, which is what makes
	 * this work on an install that picked its vault before there was anywhere
	 * to write the answer down. `vaultMemory.ts` has both rules.
	 */
	public restoreRememberedVault(): void {
		if (!this.sharedFolders || !this.vaultMemory) return;

		const remembered = this.vaultMemory.get();
		const recall = recallVault(
			remembered,
			this.sharedFolders.items().map((folder) => ({
				guid: folder.guid,
				isVaultScope: folder.isVaultScope,
			})),
			this.appId,
		);

		if (recall.action === "forget") {
			// The link on disk was written by a different local vault (#71).
			// Dropping it leaves this vault not syncing and the screen asking,
			// which is the honest answer to a question whose recorded answer
			// belongs to somebody else.
			this.warn(
				"The linked cloud vault on disk belongs to a different local vault, so it is being dropped",
			);
			this.forgetVault();
			return;
		}

		if (recall.action === "remember") {
			this.log("Remembering the cloud vault this device syncs", recall.id);
			// The name travels only while the id it was written for does. A
			// mounted share knows its own id and not what Knap calls it, so
			// changing the id drops the name rather than carrying the old one
			// across (#71).
			this.rememberVault({
				id: recall.id,
				name: remembered?.id === recall.id ? remembered?.name : undefined,
				serverId: remembered?.id === recall.id ? remembered?.serverId : undefined,
			});
			return;
		}
		if (recall.action !== "mount") return;

		const id = recall.vault.id;
		if (!id) return;
		try {
			this.log("Putting the remembered cloud vault back", id);
			const folder = this.sharedFolders.new("", id, "relay-onprem", false, "vault");
			if (folder?.settings) {
				folder.settings.onpremServerId = recall.vault.serverId ?? KNAP_SERVER_ID;
			}
			this.folderNavDecorations?.quickRefresh();
		} catch (e: unknown) {
			// Something already covers this vault, or refused to sit beside
			// what does. Say so and leave the screen to ask, which is the
			// behaviour this whole file is trying to avoid but is still better
			// than a half-mounted share.
			this.warn(
				`Could not put the remembered cloud vault back: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/** The cloud vault this device is meant to be syncing, if it knows. */
	public rememberedVault(): string | undefined {
		return rememberedVaultId(this.vaultMemory?.get());
	}

	/**
	 * What this vault is doing, read off the folders and the sync queue.
	 *
	 * The corner of the window and the settings screen both call this, so
	 * neither can describe the same vault differently from the other.
	 *
	 * The three things a folder is asked are in `vaultStatus.ts`, and the
	 * reason there are three rather than one is #40: `synced` alone is a fact
	 * about the folder's own metadata document, it goes true the first time
	 * that one document catches up, and nothing ever puts it back. It said up
	 * to date over 2,567 notes that had no bodies at all.
	 */
	public readVaultStatus(): VaultReading {
		// The rebuilt client, when this build has one, is the whole truth
		// about this vault: it holds the link, the socket and the queue.
		// Reading it here rather than beside it is what keeps the corner of
		// the window and the Knap screen from wording one vault two ways.
		if (this.knapSync) {
			const status = this.knapSync.status();
			// The corner adds the two kinds of file together, because it has
			// room for two numbers and not four; the settings screen behind
			// it keeps notes and attachments apart (ADR-0088).
			//
			// The count and the bar are the pass at start while it is going:
			// a restart over a vault that is already here compares every
			// note and moves none, so the two directions are zero for
			// minutes and the corner had nothing to draw. `statusBarPaint`
			// reads these only when the directions are empty, so a first
			// sync keeps its arrows.
			const checked = checkedCounts(status);
			const passing = isMoving(status.word) && checking(status);
			return {
				word: status.word,
				dot: status.dot,
				done: checked.done,
				total: checked.total,
				counts:
					status.problems > 0
						? String(status.problems)
						: passing
							? syncCounts(checked.done, checked.total)
							: "",
				progress: passing ? syncProgress(checked.done, checked.total) : undefined,
				up: status.up + status.files.up,
				down: status.down + status.files.down,
			};
		}
		const signedIn = this.loginManager?.isLoggedInToServer?.(KNAP_SERVER_ID) ?? false;
		return vaultReading(
			signedIn,
			(this.sharedFolders?.items() ?? []).map((folder) => {
				const work = folder.backgroundSync?.getFolderWork(folder) ?? {
					total: 0,
					completed: 0,
				};
				const inbound = folder.inbound;
				return {
					shouldConnect: folder.shouldConnect,
					synced: folder.synced,
					filling: folder.filling,
					total: work.total,
					completed: work.completed,
					listed: inbound.listed,
					missing: inbound.missing,
				};
			}),
			this.vaultHeld,
		);
	}

	/**
	 * Colour the status bar icon, and put the count beside it while there is
	 * one.
	 *
	 * Green is the point of the thing. Somebody who has just written a note
	 * wants to know it left the building, and reading that off the corner of
	 * the window beats opening a menu to find out. The same goes the other
	 * way for a vault that has thousands of notes still to send, which is why
	 * the number is here and not only on a web page.
	 */
	private paintRelayStatus(
		statusBarItem: HTMLElement,
		iconEl: HTMLElement,
		countEl: HTMLElement,
		trackEl: HTMLElement,
		fillEl: HTMLElement,
	) {
		const reading = this.readVaultStatus();
		// The corner lags the vault by two seconds at each end, so an ordinary
		// save never reaches it. Everything a person has to act on goes up at
		// once; only Syncing waits (ADR-0088).
		this.corner = settle(
			this.corner,
			isMoving(reading.word),
			reading.up + reading.down,
			Date.now(),
		);
		const corner = statusBarPaint(reading, this.corner);
		for (const dot of SYNC_DOT_NAMES) {
			iconEl.toggleClass(`relay-status-${dot}`, dot === corner.dot);
		}
		countEl.setText(corner.count);
		// The bar goes when there is no denominator behind it, rather than
		// sitting there empty: an empty track beside an up to date vault is a
		// job nobody has started, which is the opposite of what it means.
		trackEl.toggleClass("relay-status-track-on", corner.percent !== undefined);
		if (corner.percent !== undefined) {
			fillEl.style.width = `${corner.percent}%`;
		}
		statusBarItem.setAttribute("aria-label", corner.label);
	}

	/**
	 * Ensure shareClientManager exists, creating it lazily if needed
	 */
	private async ensureShareClientManager(): Promise<void> {
		if (this.shareClientManager) return;
		const settings = this.relayOnPremSettings.get();
		if (!settings.enabled || settings.servers.length === 0) return;
		const multiServerAuthManager = this.loginManager.getMultiServerAuthManager();
		if (!multiServerAuthManager) return;
		this.shareClientManager = new RelayOnPremShareClientManager(
			multiServerAuthManager,
			settings.servers,
		);
		if (!this.webSyncManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(this.vault, this.shareClientManager);
		}
	}

	private async _initialFullSync(shares: ShareWithServer[]): Promise<void> {
		if (!this.shareClientManager) return;
		this.log("Running initial full-sync for stale auto-sync shares", shares.length);
		// TR-25-followup (#1d244fb4): pushes content directly, bypassing
		// WebSyncManager's own syncFile()/syncFolderFile(), so it takes the
		// same echo-guard those use.
		const { withOutboundSyncGuard } = await import("./WebSyncManager");
		await withOutboundSyncGuard(this.webSyncManager, async () => {
			for (const share of shares) {
				try {
					const folderAbs = this.vault.getAbstractFileByPath(share.path);
					if (!(folderAbs instanceof TFolder)) {
						this.log("Folder not in vault, skipping initial full-sync", share.path);
						continue;
					}
					const items = this.getFolderItemsRecursive(folderAbs);
					await this.shareClientManager!.updateShare(share.serverId, share.id, {
						web_folder_items: items,
					});
					if (share.web_slug) {
						let syncedCount = 0;
						for (const item of items) {
							if (item.type === "doc" || item.type === "canvas") {
								try {
									const f = this.vault.getAbstractFileByPath(`${share.path}/${item.path}`);
									if (f instanceof TFile) {
										const content = await this.vault.read(f);
										if (!content) {
											this.log("Skipping empty file in initial full-sync", item.path);
											continue;
										}
										await this.shareClientManager!.syncFolderFileContent(
											share.serverId, share.web_slug, item.path, content
										);
										syncedCount++;
										await new Promise<void>(r => window.setTimeout(r, 200));
									}
								} catch (e: unknown) {
									this.log("Failed to sync file in initial full-sync", item.path, String(e));
								}
							}
						}
						this.log("Initial full-sync done for share", share.path, syncedCount, "of", items.length);
					}
					// Bump web_content_updated_at so the stale check won't re-trigger on next startup
					await this.shareClientManager!.updateShare(share.serverId, share.id, {
						web_content_updated_at: new Date().toISOString(),
					});
				} catch (e: unknown) {
					this.log("Initial full-sync failed for share", share.path, String(e));
				}
			}
		});
	}

	/**
	 * Recursively build folder items for web publishing
	 */
	private getFolderItemsRecursive(folder: TFolder): FolderItem[] {
		const items: FolderItem[] = [];
		const basePath = folder.path;
		const process = (f: TFolder) => {
			for (const child of f.children) {
				const rel = child.path.substring(basePath.length + 1);
				if (child instanceof TFile) {
					if (child.extension === "canvas") {
						items.push({ path: rel, name: child.basename, type: "canvas" });
					} else if (child.extension === "md") {
						items.push({ path: rel, name: child.basename, type: "doc" });
					}
				} else if (child instanceof TFolder) {
					items.push({ path: rel, name: child.name, type: "folder" });
					process(child);
				}
			}
		};
		process(folder);
		return items;
	}

	private _onLogout() {
		this.tokenStore?.clear();
		this.relayManager?.logout();
		void this._liveViews.refresh("logout");
	}

	private _onLogin() {
		this.sharedFolders.load();
		this.restoreRememberedVault();

		// Load relay-onprem shares after login
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}
		this.relayManager?.login();
		void this._liveViews.refresh("login");
	}

	async openSettings(path: string = "/") {
		const setting = (this.app as unknown as ObsidianApp).setting;
		await setting.open();
		await setting.openTabById(PLUGIN_ID);
		this.settingsTab.navigateTo(path);
	}

	patchWebviewer(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions
		const plugin = this;
		try {
			if (this.webviewerPatched) {
				return;
			}

			const webviewer = (this.app as unknown as ObsidianApp).internalPlugins?.plugins?.webviewer;
			if (!webviewer?.instance?.options || !webviewer.enabled) {
				this.warn("Webviewer plugin not found or not initialized");
				return;
			}

			const options = webviewer.instance.options;
			const originalDesc = Object.getOwnPropertyDescriptor(
				options,
				"openExternalURLs",
			);

			if (!originalDesc) {
				this.warn("Could not find openExternalURLs property");
				return;
			}

			// Capture the open-url event in a closure so the getter below can access it
			// without relying on the deprecated window.event global
			let capturedOpenUrlEvent: { type?: string; detail?: { url?: string } } | undefined;
			const openUrlListener = (e: Event) => {
				capturedOpenUrlEvent = e;
			};
			activeWindow.addEventListener("open-url", openUrlListener, true);

			Object.defineProperty(options, "openExternalURLs", {
				get(): boolean | undefined {
					const currentEvent = capturedOpenUrlEvent;
					if (currentEvent?.type === "open-url" && currentEvent?.detail?.url) {
						const url = currentEvent.detail.url;
						for (const pattern of plugin.interceptedUrls) {
							if (
								(typeof pattern === "string" && url.startsWith(pattern)) ||
								(pattern instanceof RegExp && pattern.test(url))
							) {
								plugin.log(
									"Intercepted webviewer, opening in default browser",
									currentEvent.detail.url,
								);
								return false;
							}
						}
					}
					return originalDesc.value as boolean | undefined;
				},
				set(value: boolean) {
					originalDesc.value = value;
				},
				configurable: true,
			});

			this.register(() => {
				window.removeEventListener("open-url", openUrlListener, true);
				Object.defineProperty(options, "openExternalURLs", originalDesc);
			});

			const intercepts = this.loginManager.getWebviewIntercepts();
			intercepts.forEach((intercept) => {
				this.debug("Intercepting Webviewer for URL pattern", intercept.source);
				this.interceptedUrls.push(intercept);
			});

			const apiUrl = this.loginManager.getEndpointManager().getApiUrl();
			const apiRegExp = new RegExp(apiUrl.replace("/", "\\/") + ".*");
			this.debug("Intercepting Webviewer for URL pattern", apiRegExp.source);
			this.interceptedUrls.push(apiRegExp);

			this.webviewerPatched = true;
			this.debug("patched webviewer options");
		} catch (error: unknown) {
			this.error("Failed to patch webviewer:", error);
		}
	}

	setup() {
		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
			this.backgroundSync,
		);
		this.folderNavDecorations.refresh();

		// Load relay-onprem shares if enabled
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}

		// One world per build. A beta pointed at the rebuilt server showed the
		// relay's own settings tab beside it, listing the shares of the stack
		// this one replaces -- two lists of "cloud vaults" that disagree, with
		// nothing on either saying which server it is talking about. The
		// ordinary build is unaffected: knapBeta is null there.
		if (!this.knapSync) {
			this.addSettingTab(this.settingsTab);
		}

		const workspaceLog = curryLog("[Live][Workspace]", "log");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				void plugin._liveViews.refresh("file-open");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				workspaceLog("layout-change");
				void this._liveViews.refresh("layout-change");
			}),
		);

		const vaultLog = curryLog("[Pantalytics][Vault]", "log");

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		activeWindow.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			activeWindow.removeEventListener("unhandledrejection", rejectionListener, true),
		);

		this.registerEvent(
			this.app.vault.on("create", (tfile) => {
				// NOTE: this is called on every file at startup...
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					// claimAndUploadFile() runs the same upload-claim protection
					// addLocalDocs() has (TR-15-follow-up, #7c14871a) -- this event
					// fires for pre-existing files too, so it can race a second
					// client discovering the SAME brand-new vpath at once, same as
					// the initial-sync path.
					void folder.claimAndUploadFile(tfile);
				}
				// Update web_folder_items for auto-sync folder shares
				if (this.webSyncManager && tfile instanceof TFile) {
					void this.webSyncManager.onFileCreated(tfile);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					const folder = this.sharedFolders.find(
						(folder) => folder.path === file.path,
					);
					if (folder) {
						this.sharedFolders.delete(folder);
						return;
					}
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Delete", file.path);
					const vpath = folder.getVirtualPath(file.path);
					folder.markPendingDelete(vpath);
					void folder.whenReady().then((folder) => {
						folder.proxy.deleteFile(file.path);
					}).finally(() => {
						folder.clearPendingDelete(vpath);
					});
				}
				// Update web_folder_items for auto-sync folder shares
				void this.webSyncManager?.onFileDeleted(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// TODO this doesn't work for empty folders.
				if (file instanceof TFolder) {
					const sharedFolder = this.sharedFolders.find((folder) => {
						return folder.path == oldPath;
					});
					if (sharedFolder) {
						sharedFolder.move(file.path);
						this.sharedFolders.update();
						return;
					}
				}
				const fromFolder = this.sharedFolders.lookup(oldPath);
				const toFolder = this.sharedFolders.lookup(file.path);
				const folder = fromFolder || toFolder;
				if (fromFolder && toFolder) {
					// between two shared folders
					vaultLog("Rename", file.path, oldPath);
					fromFolder.renameFile(file, oldPath);
					toFolder.renameFile(file, oldPath);
					void this._liveViews.refresh("rename");
					this.folderNavDecorations.quickRefresh();
				} else if (folder) {
					vaultLog("Rename", file.path, oldPath);
					folder.renameFile(file, oldPath);
					void this._liveViews.refresh("rename");
					this.folderNavDecorations.refresh();
				}
				// Update web_folder_items for auto-sync folder shares
				void this.webSyncManager?.onFileRenamed(file.path, oldPath);
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (tfile) => {
				// InboundFileDownloader writes sync-artifact content via
				// vault.adapter.writeBinary(), which still fires this "modify" event
				// (the underlying file-system watcher doesn't distinguish it from a
				// user edit) — without this guard, our own inbound download for an
				// unconnected Document was mistaken for a local edit and enqueued
				// right back out via backgroundSync.enqueueSync(), which reconciles
				// by diffing the vault file against the Y.Doc's CURRENT text
				// (BackgroundSync.ts syncDocumentWebsocket). If a second client's
				// edit had merged into that Y.Doc between the inbound write and this
				// handler firing, the echoed sync would treat the (now-stale)
				// inbound content as the "local edit" and reconcile against it,
				// demoting the second client's genuine edit into a conflict-copy
				// file (TR-01's reconcileWithConflictCopy prevents outright data
				// loss, but this is still a spurious, avoidable conflict).
				// Previously only the web-auto-sync branch below checked this
				// (v1.9); this mirrors the same guard onto the SharedFolder/Document
				// path (U4).
				const isInboundEcho =
					this.inboundFileDownloader?.isInboundWriting(tfile.path) ?? false;

				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
					if (!isInboundEcho) {
						const file = folder.proxy.getFile(tfile);
						if (file && isSyncFile(file)) {
							void file.sync();
						}
						// For Documents (folder share files): if the file has no active
						// WS connection, edits bypass Y.Text entirely (no live CM binding).
						// Enqueue a background sync to push vault content to relay.
						// When connected, LiveCMPluginValue handles sync automatically.
						if (file && isDocument(file) && !file.connected) {
							void folder.backgroundSync.enqueueSync(file);
						}
					}
					// Trigger metadata resolve with the actual TFile (not our Document proxy)
					this.timeProvider.setTimeout(() => {
						this.app.metadataCache.trigger("resolve", tfile);
					}, 500);
				}

				// Handle auto-sync to web (v1.8.1); skip if InboundFileDownloader is writing (echo-loop guard, v1.9)
				if (this.webSyncManager && tfile instanceof TFile && !isInboundEcho) {
					void this.webSyncManager.onFileModified(tfile);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions where `this` is rebound
		const plugin = this;

		getPatcher().patch(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old: unknown) {
				return function (this: unknown, file: unknown) {
					plugin._liveViews.wipe();
					return (old as (...args: unknown[]) => unknown).call(this, file);
				};
			},
		});

		getPatcher().patch(this.app.vault, {
			process(old: unknown) {
				return function (
					this: unknown,
					tfile: unknown,
					fn: (data: string) => string,
					options: unknown,
				) {
					try {
						const tfileTyped = tfile as { path?: string };
						const folder = tfileTyped.path ? plugin.sharedFolders.lookup(tfileTyped.path) : undefined;
						if (folder) {
							if (!(tfile instanceof TFile)) return;
						const file = folder.proxy.getFile(tfile);
							if (file && isDocument(file)) {
								file.process(fn);
							}
						}
					} catch (e: unknown) {
						plugin.log(e);
					}

					return (old as (...args: unknown[]) => unknown).call(this, tfile, fn, options);
				};
			},
		});

		this.patchWebviewer();

		withFlag(flag.enableNewLinkFormat, () => {
			getPatcher().patch(MetadataCache.prototype, {
				fileToLinktext(next: unknown) {
					const old = next as (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) => string;
					return function (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) {
						const folder = plugin.sharedFolders.lookup(file.path);
						if (folder) {
							if (omitMdExtension === void 0) {
								omitMdExtension = true;
							}

							const fileName =
								file.extension === "md" && omitMdExtension
									? file.basename
									: file.name;
							const normalizedFileName = normalizePath(file.name);
							const destinationFiles = (
								plugin.app.metadataCache as unknown as { uniqueFileLookup: Map<string, TFile[]> }
							).uniqueFileLookup.get(normalizedFileName.toLowerCase());

							// If there are no conflicts (unique file), return the fileName
							if (
								destinationFiles &&
								destinationFiles.length === 1 &&
								destinationFiles[0] === file
							) {
								return fileName;
							} else {
								// If there are conflicts, use the relative path
								const filePath =
									file.extension === "md" && omitMdExtension
										? file.path.slice(0, file.path.length - 3)
										: file.path;
								const rpath = relative(sourcePath, filePath);
								if (rpath === "../" + fileName) {
									return "./" + fileName;
								}
								return rpath;
							}
						}
						// @ts-ignore
						return old.call(this, file, sourcePath, omitMdExtension);
					};
				},
			});
		});

		interface Parameters {
			action: string;
			relay?: string;
			id?: string;
			version?: string;
		}

		// The OAuth callback. Registered at load rather than at sign-in,
		// because the browser may come back after Obsidian was restarted and
		// a handler registered per flow would not be there to catch it.
		this.registerObsidianProtocolHandler(OAUTH_CALLBACK_ACTION, (e) => {
			oauthDeepLinkReceiver.handleCallback(e as unknown as Record<string, string>);
		});

		this.registerObsidianProtocolHandler(`${PLUGIN_ID}/settings/relays`, (e) => {
			const parameters = e as unknown as Parameters;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
			void this.openSettings(path);
		});

		this.registerObsidianProtocolHandler(
			`${PLUGIN_ID}/settings/shared-folders`,
			(e) => {
				const parameters = e as unknown as Parameters;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
				void this.openSettings(path);
			},
		);

		this.registerObsidianProtocolHandler(`${PLUGIN_ID}/billing-ok`, (e) => {
			new Notice("Payment successful! Refreshing billing data...");
			// Clear billing cache by refreshing settings
			void this.openSettings();
		});

		// Same reason as loadRelayOnPremShares: one syncer per build. The
		// rebuilt client does its own syncing over its own socket.
		if (!this.knapSync) {
			this.backgroundSync.start();
		}
	}

	removeCommand(command: string): void {
		// [Polyfill] removeCommand was added in 1.7.2
		if (requireApiVersion("1.7.2")) {
			// @ts-ignore
			super.removeCommand(command);
		} else {
			const appAny = this.app as unknown as ObsidianApp;
			const appCommands = appAny.commands;
			const qualifiedCommand = `${PLUGIN_ID}:${command}`;
			if (
				Object.prototype.hasOwnProperty.call(appCommands.commands, qualifiedCommand) ||
				appAny.hotkeyManager.removeDefaultHotkeys(qualifiedCommand)
			) {
				delete appCommands.commands[qualifiedCommand];
				delete appCommands.editorCommands[qualifiedCommand];
			}
		}
	}

	getKnapLink(): KnapLink | null {
		return this.settings.get().knap ?? null;
	}

	async saveKnapLink(value: KnapLink | null): Promise<void> {
		await this.settings.update((settings) => ({ ...settings, knap: value }));
	}

	onunload() {
		this.knapSync?.stop();
		this.knapSync = null;
		// Save settings before cleanup to persist any changes. onunload cannot
		// await, so the promise is kept: the fields the write needs (app,
		// manifest, vault) are nulled only after it settles, further down.
		// Before that, an update's unload raced its own save: the old bundle's
		// write could land after the new bundle had already loaded and
		// migrated, putting old settings on top of new ones.
		const settingsFlushed: Promise<unknown> =
			this.settings?.save() ?? Promise.resolve();

		// One failed teardown must not stop the rest: whatever survives here
		// keeps running beside the next bundle after an update, which is the
		// two-plugins-on-one-vault shape. Each step falls alone.
		const safely = (label: string, fn: () => void) => {
			try {
				fn();
			} catch (e) {
				console.warn(`[Pantalytics] teardown of ${label} failed`, e);
			}
		};

		// Cleanup all monkeypatches and destroy the singleton
		Patcher.destroy();

		this.timeProvider?.destroy();

		this.folderNavDecorations?.destroy();

		// Note: detachLeavesOfType should not be called in onunload (Obsidian handles leaf cleanup)

		this._liveViews?.destroy();
		this._liveViews = null as unknown as LiveViewManager;

		this.relayManager?.destroy();
		this.relayManager = null as unknown as RelayManager;

		this.tokenStore?.stop();
		this.tokenStore?.clearState();
		this.tokenStore?.destroy();
		this.tokenStore = null as unknown as LiveTokenStore;

		this.networkStatus?.stop();
		this.networkStatus?.destroy();
		this.networkStatus = null as unknown as NetworkStatus;

		this.openModals.forEach((modal) => {
			modal.close();
		});
		this.openModals.length = 0;

		this.sharedFolders?.destroy();
		this.sharedFolders = null as unknown as SharedFolders;

		this.settingsTab?.destroy();
		this.settingsTab = null as unknown as LiveSettingsTab;

		this.loginManager?.destroy();
		this.loginManager = null as unknown as LoginManager;

		this.backgroundSync?.destroy();
		this.backgroundSync = null as unknown as BackgroundSync;

		// Cleanup InboundSyncPoller (v1.9)
		if (this.inboundSyncPoller) {
			this.inboundSyncPoller.destroy();
			this.inboundSyncPoller = undefined;
		}

		// Cleanup InboundFileDownloader (v1.9)
		if (this.inboundFileDownloader) {
			this.inboundFileDownloader.destroy();
			this.inboundFileDownloader = undefined;
		}

		// Cleanup WebSyncManager (v1.8.1)
		if (this.webSyncManager) {
			this.webSyncManager.destroy();
			this.webSyncManager = undefined;
		}

		safely("hashStore", () => this.hashStore?.destroy());
		this.hashStore = null as unknown as ContentAddressedFileStore;

		this.app?.workspace.updateOptions();
		(this.app as unknown as ObsidianApp).reloadRelay = undefined;
		this.fileManager = null as unknown as FileManager;

		safely("debugSettings", () => this.debugSettings?.destroy());
		this.debugSettings = null as unknown as NamespacedSettings<DebugSettings, Record<string, unknown>>;
		safely("reportingSettings", () => this.reportingSettings?.destroy());
		this.reportingSettings = null as unknown as NamespacedSettings<ReportingSettings, Record<string, unknown>>;
		safely("folderSettings", () => this.folderSettings?.destroy());
		this.folderSettings = null as unknown as NamespacedSettings<SharedFolderSettings[], Record<string, unknown>>;

		// Destroy FeatureFlagManager before destroying featureSettings
		safely("FeatureFlagManager", () => FeatureFlagManager.destroy());

		safely("featureSettings", () => this.featureSettings?.destroy());
		this.featureSettings = null as unknown as NamespacedSettings<FeatureFlags, Record<string, unknown>>;
		safely("vaultMemory", () => this.vaultMemory?.destroy());
		this.vaultMemory = null as unknown as NamespacedSettings<RememberedVault, Record<string, unknown>>;
		safely("loginSettings", () => this.loginSettings?.destroy());
		this.loginSettings = null as unknown as NamespacedSettings<LoginSettings, Record<string, unknown>>;
		safely("endpointSettings", () => this.endpointSettings?.destroy());
		this.endpointSettings = null as unknown as NamespacedSettings<EndpointSettings, Record<string, unknown>>;
		safely("relayOnPremSettings", () => this.relayOnPremSettings?.destroy());
		this.relayOnPremSettings = null as unknown as NamespacedSettings<RelayOnPremSettings, Record<string, unknown>>;

		// The settings write above needs these three; they go last, once it
		// has settled either way.
		void settingsFlushed.finally(() => {
			this.app = null as unknown as App;
			this.manifest = null as unknown as PluginManifest;
			this.vault = null as unknown as Vault;
		});

		this.interceptedUrls.length = 0;
		PostOffice.destroy();

		this.notifier = null as unknown as ObsidianNotifier;

		auditTeardown();
		void flushLogs();
	}

	loadSettings() {
		void this.settings.load();
	}

	async saveSettings() {
		await this.settings.save();
	}
}
