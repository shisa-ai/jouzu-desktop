import { ChatWorkspace } from "./chat-workspace";
import { ToolsPanel } from "./tools-panel";
import { ArtifactsPanel } from "./artifacts-panel";
import { LauncherPage } from "./components/launcher-page";
import { ProviderPicker } from "./components/ui/provider-picker";
import { recoveryText } from "./recovery-text";
import { describeError, explainError } from "./runtime-errors";
import { NoticeRow } from "./session-alerts-view";
import { UpdatePreview } from "./update-preview";
import { GitBashSection, useGitBash } from "./git-bash-section";
import { TerminalSection } from "./terminal-section";
import { CommandEntrySection } from "./command-entry-section";
import { ComponentSection, useComponent } from "./components/component-row";
import { ReportSection } from "./report-section";
import { useJouzuUpdate } from "./use-jouzu-update";
import { useLauncherUpdate } from "./use-launcher-update";
import { Label } from "./components/ui/label";
import { openUrl } from "@tauri-apps/plugin-opener";
import { catalogChangeSummary, parseControlState, type ControlState, type HeldCatalog } from "./control-state";

import { controlCancel, controlRequest, subscribeControl } from "./api/control-client";
import { useApi } from "./api/context";
import type { WarmView } from "./warm-runtime";
import { Switch } from "./components/ui/switch";
import { listen } from "@tauri-apps/api/event";
import jouzuIcon from "./assets/jouzu.svg";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Input } from "./components/ui/input";
import { getVersion } from "@tauri-apps/api/app";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Search, X, ArrowUpRight, Settings, Languages, KeyRound, SlidersHorizontal, RefreshCw, LoaderCircle, Minus, Maximize2, Minimize2, Plus, Copy, Check, Wrench, Palette } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "./components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { ScrollArea } from "./components/ui/scroll-area";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "./components/ui/card";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./components/ui/select";
import { Button } from "./components/ui/button";
import { JouzuLoader } from "./components/ui/jouzu-loader";
import { Progress } from "./components/ui/progress";
import { catalogReview, messages, locales, resolveLocale, type Locale } from "./i18n";
import { type Workspace } from "./history";
import { parseDiagnostics, type Diagnostics } from "./diagnostics";
interface LauncherState { platform: "windows" | "macos" | "linux"; recent: Workspace[]; ready: boolean; bash: boolean; bundled_git: boolean }
interface Components { jouzu: string | null; development: boolean; launcherUpdaterConfigured?: boolean; jouzuUpdaterConfigured?: boolean; build?: string; commit?: string }
interface RuntimeReport { status?: string; version: string | null; expectedVersion?: string; versionCurrent?: boolean; minimumVersion?: string; verifiedVersions?: string[]; mandatory?: boolean; root: string | null; app: string | null; node: boolean; nodeVersion: string | null; nodeCurrent: boolean; git: boolean; terminal: boolean }
type Theme = "dark" | "light" | "system";

export function App() {
  const api = useApi();
  const native = api.capabilities.native;
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(localStorage.getItem("jouzu.ui.language") ?? navigator.language));
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("jouzu.ui.theme");
    return saved === "light" || saved === "system" ? saved : "dark";
  });
  useEffect(() => {
    localStorage.setItem("jouzu.ui.theme", theme);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = theme === "light" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("light", light);
      document.documentElement.style.colorScheme = light ? "light" : "dark";
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const t = messages[locale];
  const review = catalogReview[locale];
  const [activePath, setActivePath] = useState<string | null>(null);
  const [newSession, setNewSession] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [chatBusy, setChatBusy] = useState(false);
  // The entry session connects behind the same loader the launcher starts with; after
  // that first connect, a session switch shows the chat's own "Starting session…".
  const [entryBooting, setEntryBooting] = useState(false);
  const [entryWarm, setEntryWarm] = useState<WarmView | null>(null);
  const [bootNow, setBootNow] = useState(() => Date.now());
  const retryEntryWarm = useRef<() => void>(() => {});
  useEffect(() => {
    if (!entryBooting || entryReady.current) return;
    const timer = window.setInterval(() => setBootNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [entryBooting]);
  const entryReady = useRef(false);
  const [restartPending, setRestartPending] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  // A held revision waits for the user; nothing is applied until they decide.
  const [heldCatalog, setHeldCatalog] = useState<HeldCatalog | null>(null);
  const [catalogDeciding, setCatalogDeciding] = useState(false);
  const catalogAttempted = useRef(false);
  const [japaneseOverride, setJapaneseOverride] = useState<boolean | null>(null);
  const japaneseChoice = japaneseOverride ?? locale === "ja";

  useEffect(() => { document.documentElement.lang = locale; localStorage.setItem("jouzu.ui.language", locale); }, [locale]);
  const [state, setState] = useState<LauncherState | null>(null);
  // An app-level failure is shown where it happened: settings in the settings
  // window (and the setup page), folder actions with the folder list. Never a
  // floating banner; the technical text stays behind Details.
  const [error, setError] = useState<{ place: "settings" | "folders"; text: string; details?: string } | null>(null);
  const fail = (place: "settings" | "folders", failure: unknown) => setError({ place, ...explainError(failure, t.error) });
  // Failures nobody can act on (a window button, a copy, an event subscription) go to the log only.
  const quiet = (failure: unknown) => console.warn("[jouzu]", describeError(failure));
  const errorNotice = (place: "settings" | "folders") => error?.place === place
    ? <NoticeRow alert={{ id: `app-${place}`, level: "error", text: error.text, details: error.details, actions: [], dismiss: () => setError(null) }} />
    : null;
  // The first status read decides the whole window: the dot loader while it is in flight, the error and a retry if it never lands.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusCopied, setStatusCopied] = useState(false);
  const [operation, setOperation] = useState<"choosing" | "launching" | "preparing" | "saving" | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [components, setComponents] = useState<Components | null>(null);
  const jouzuUpdater = useJouzuUpdate(components?.jouzuUpdaterConfigured === true, () => {
    void invoke<Components>("component_versions").then(setComponents).catch(error => fail("settings", error));
    // A runtime update is only visible to a fresh supervised process.
    requestSessionRestart();
  }, native);
  const updater = useLauncherUpdate(components?.launcherUpdaterConfigured === true);
  const gitBash = useGitBash();
  const runtime = useComponent<RuntimeReport>("runtime_report");
  const [settingsTab,setSettingsTab] = useState("providers");
  // Where a header jump lands in the System list: the row that has something waiting.
  const [updateFocus,setUpdateFocus] = useState<number | null>(null);
  // A machine whose console host draws the interface incorrectly is told so, and the fix is one step away.
  const [repair, setRepair] = useState<{ error: string | null } | null>(null);
  const [sort, setSort] = useState(() => localStorage.getItem("jouzu.folder.sort") ?? "added");
  const [connectionMode, setConnectionMode] = useState<"builtin" | "custom">("builtin");
  const [providerQuery, setProviderQuery] = useState("");
  const [addingConnection, setAddingConnection] = useState(false);
  const [query, setQuery] = useState("");
  const [setup, setSetup] = useState<ControlState | null>(null);
  // One state machine: the runtime is an input to it, not a second screen.
  // null = still probing, false = onboarding installs it, true = the service can run.
  const [runtimePresent, setRuntimePresent] = useState<boolean | null>(null);
  // One prepare surface: real download bytes, then package and verification phases.
  const [prepare, setPrepare] = useState<{ phase: string; downloaded: number; total: number | null; error: string | null }>({ phase: "", downloaded: 0, total: null, error: null });
  // There is no setup wizard: a missing runtime auto-prepares, and a missing
  // model is handled in the workspace, where Settings remains reachable.
  const modelReady = setup?.modelReady;
  const needsSetup = modelReady === false;
  const [device, setDevice] = useState<{url:string;code:string} | null>(null);
  const [providerDevice, setProviderDevice] = useState<{url:string;code:string;provider:string} | null>(null);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const window = getCurrentWindow();
    const sync = () => { void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    sync();
    const unlisten = window.onResized(sync);
    return () => { disposed = true; void unlisten.then(remove => remove()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!native) return;
    const unlisten = listen("new-session", () => setNewSession(true));
    return () => { void unlisten.then(remove => remove()).catch(() => {}); };
  }, []);
  useEffect(() => {
    // Device codes arrive from the host, not from a Tauri event.
    return subscribeControl(device => {
      if (device.provider && device.provider !== "shisa") setProviderDevice({ ...device, provider: device.provider });
      else setDevice({ url: device.url, code: device.code });
    });
  }, []);
  const [envRows, setEnvRows] = useState<{name:string;value:string;enabled:boolean}[]>([]);
  const [editingEnv, setEditingEnv] = useState<number | null>(null);
  const [envLoaded, setEnvLoaded] = useState(false);
  async function readEnvironment() {
    try { setEnvRows(await api.settings.environment.read()); setEnvLoaded(true); setEditingEnv(null); }
    catch (error) { fail("settings", error); }
  }
  async function saveEnvironment() {
    setOperation("saving"); setError(null);
    try { await api.settings.environment.save(envRows); setEditingEnv(null); setSetup(parseControlState(await controlRequest({ action: "status" }))); }
    catch (error) { fail("settings", error); }
    finally { setOperation(null); }
  }
  const [custom, setCustom] = useState({provider:"",url:"",model:"",edit:false,imageInput:false,contextWindow:32768,maxTokens:4096});
  const [provider, setProvider] = useState("");
  const [token, setToken] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [notice, setNotice] = useState<"requested" | "removed" | null>(null);
  const busy = operation !== null;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // The configuration service allows one operation at a time; serialize requests
  // so development remounts or overlapping menu opens cannot collide.
  const controlQueue = useRef<Promise<unknown>>(Promise.resolve());
  const initialStatusRequested = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  async function addFolders(paths: string[]) {
    setOperation("saving"); setError(null);
    try {
      await api.workspaces.add(paths);
      setQuery("");
      await refresh();
      if (paths.length && !activePath) setActivePath(paths[0]);
    }
    catch (error) { fail("folders", error); }
    finally { setOperation(null); }
  }
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const subscription = getCurrentWindow().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { setDragging(false); return; }
      const rect = listRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      setDragging(inside && payload.type !== "drop");
      if (payload.type === "drop" && inside && !busyRef.current && !settingsOpen) void addFolders(payload.paths);
    });
    subscription.then(unlisten => { if (disposed) unlisten(); }).catch(error => quiet(error));
    return () => { disposed = true; subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [settingsOpen]);
  function requestSessionRestart() {
    if (chatBusy) setRestartPending(true);
    else setSessionRevision(value => value + 1);
  }
  /** The prepare screen: one automatic install, no choices. */
  async function runPrepare() {
    setPrepare({ phase: "start", downloaded: 0, total: null, error: null });
    try {
      await invoke<string>("runtime_install");
      const report = await invoke<RuntimeReport>("runtime_report");
      if (report?.mandatory === true || report?.nodeCurrent === false) throw new Error(`The runtime update did not finish (${report?.version ?? "unknown"}).`);
      setRuntimePresent(true);
      await configure({ action: "profile", profile: japaneseChoice ? "ja" : "core" });
      void loadComponents();
      await readStatus();
    } catch (error) {
      prepareStarted.current = false;
      setPrepare(current => ({ ...current, error: describeError(error) }));
    }
  }

  const prepareStarted = useRef(false);
  useEffect(() => {
    if (runtimePresent !== false) { prepareStarted.current = false; return; }
    if (prepareStarted.current) return;
    prepareStarted.current = true;
    void runPrepare();
  }, [runtimePresent]);
  async function configure(request: Record<string, unknown>, options: { restart?: boolean } = {}) {
    // A status read is not a user-visible change; only mutations show progress.
    const mutates = request.action !== "status";
    const run = controlQueue.current.then(async () => {
      if (mutates) setOperation("saving");
      setError(null);
      try {
        const next = parseControlState(await controlRequest(request as Record<string, unknown>));
        setSetup(next);
        // Provider, credential and model changes only take effect in a fresh runtime process.
        // A catalog refresh decides for itself: only an activated revision needs a new runtime.
        if (options.restart !== false && request.action !== "status" && request.action !== "import" && request.action !== "profile" && request.action !== "refresh-catalogs") requestSessionRestart();
        return next;
      }
      catch (error) { fail("settings", error); return null; }
      finally { if (mutates) setOperation(null); setDevice(null); setProviderDevice(null); }
    });
    controlQueue.current = run.catch(() => {});
    return run;
  }
  async function readStatus() {
    // The first status read shares the control pipe with every other request, so it waits its turn like they do.
    const run = controlQueue.current.then(async () => {
      setStatusError(null);
      try { setSetup(parseControlState(await controlRequest({ action: "status" }))); }
      catch (error) { setStatusError(describeError(error)); }
    });
    controlQueue.current = run.catch(() => {});
    return run;
  }
  async function openDeviceUrl(value: string) {
    // Only the two documented sign-in origins may reach the system browser.
    const url = new URL(value);
    const shisa = url.origin === "https://platform.shisa.ai" && url.pathname === "/connect";
    const openai = url.origin === "https://auth.openai.com";
    if ((!shisa && !openai) || url.username || url.password) throw new Error(t.loginUrl);
    await openUrl(url.href);
  }
  function openUpdatePanel() {
    // A waiting update is not a question to re-ask: the header opens the System list on the row that has it.
    setUpdateFocus(jouzuUpdater.version ? 0 : 1);
    setSettingsTab("system");
    setSettingsOpen(true);
  }
  async function copyStatusError(text = statusError) {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else { const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
      setStatusCopied(true); setTimeout(() => setStatusCopied(false), 2000);
    } catch (error) { quiet(error); }
  }
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!settingsOpen) return; if (!setup && !busyRef.current) void configure({ action: "status" }); void readEnvironment(); }, [settingsOpen]);
  const workspaceState = (recent: unknown[]): LauncherState => ({
    platform: navigator.userAgent.includes("Windows") ? "windows" : navigator.userAgent.includes("Mac") ? "macos" : "linux",
    recent: recent as unknown as Workspace[], ready: true, bash: false, bundled_git: false,
  });
  // The workspace list is host data like everything else; the shell no longer provides it.
  const refresh = async () => setState(workspaceState((await api.workspaces.list()) ?? []));
  const loadComponents = () => invoke<Components>("component_versions")
    .then(setComponents)
    .catch(error => fail("settings", error));
  // Diagnostics are separate from the launcher state: a missing record must not fail the window.
  const refreshDiagnostics = async () => {
    try { setDiagnostics(parseDiagnostics(await invoke<unknown>("diagnostics"))); }
    catch { setDiagnostics(null); }
  };
  useEffect(() => {
    // One data source: the host API. Native-only work below stays behind the
    // capability flag rather than a second boot path.
    void (async () => {
      try {
        const recent = (await api.workspaces.list()) ?? [];
        const platform = navigator.userAgent.includes("Windows")
          ? "windows"
          : navigator.userAgent.includes("Mac")
            ? "macos"
            : "linux";
        setState({ platform, recent: recent as unknown as Workspace[], ready: true, bash: false, bundled_git: false });
        setRuntimePresent(true);
        void readStatus();
      } catch (error) {
        fail("folders", error);
      }
    })();
    if (api.capabilities.native) {
      void refreshDiagnostics();
      getVersion().then(setVersion).catch(error => fail("settings", error));
      void invoke<RuntimeReport>("runtime_report").then(report => {
        if (report?.mandatory === true || report?.nodeCurrent === false) { setRuntimePresent(false); return; }
        setRuntimePresent(true);
        void (async () => { try { await invoke("image_tool_ensure"); } catch { /* the tool is optional on a fixture */ } })();
        void loadComponents();
      }).catch(error => {
        // Only a missing runtime belongs to onboarding; any other report failure
        // (an unsupported probe, a broken fixture) must not hide the workspace.
        if (String(error).includes("application files are missing")) setRuntimePresent(false);
        else setRuntimePresent(true);
      });
    }
  }, []);
  // The prepare screen only mirrors the installer's own events; it never guesses progress.
  useEffect(() => {
    if (!native) return;
    const pending = listen<{ phase: string; downloaded?: number; total?: number | null }>("runtime-install-progress", event => {
      setPrepare(current => ({
        ...current,
        phase: event.payload.phase,
        downloaded: event.payload.downloaded ?? current.downloaded,
        total: event.payload.total ?? current.total,
      }));
    });
    return () => { pending.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  // When the window's code first runs: the gap from host start to here is the webview's.
  useEffect(() => { api.runtime.mark?.("ui.boot"); }, []);
  const initialWorkspaceChosen = useRef(false);
  useEffect(() => {
    if (initialWorkspaceChosen.current || activePath || !state) return;
    const saved = localStorage.getItem("jouzu.chat.workspace");
    const first = state.recent.find(item => item.path === saved)?.path ?? state.recent[0]?.path;
    if (first) { initialWorkspaceChosen.current = true; setActivePath(first); }
  }, [state, activePath]);
  useEffect(() => {
    if (activePath) localStorage.setItem("jouzu.chat.workspace", activePath);
  }, [activePath]);
  // A signed-in account supplies models through Jouzu's published catalog. The chat shell
  // asks for a refresh only when the connected runtime has no models, so warm starts do not
  // pay a network round trip. A successful refresh restarts the session with the new catalog.
  // A refresh is cheap and the runtime's own terminal build does it at startup, so the
  // desktop does it too. Only an activated revision needs a new runtime; a held revision
  // waits for the user's decision in the catalog dialog.
  async function refreshModelCatalog(force = false) {
    if (catalogAttempted.current && !force) return;
    catalogAttempted.current = true;
    setCatalogRefreshing(true);
    try {
      // A newly issued account key can lag its catalog by a moment. Retry the
      // refresh before leaving a signed-in install with an empty model list.
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await configure({ action: "refresh-catalogs" });
        if (next) {
          const outcome = next.catalog;
          if (outcome?.held) setHeldCatalog(outcome.held);
          // Nothing changed on disk unless a source activated a revision. An adapter
          // that reports no outcome keeps the older behaviour and rebinds.
          if (!outcome || outcome.sources.some(source => source.status === "activated")) requestSessionRestart();
          return;
        }
        if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    finally { setCatalogRefreshing(false); }
  }
  /** Apply or discard the held revision the dialog is showing. Escape keeps it held. */
  async function decideHeldCatalog(choice: "accept" | "reject") {
    const held = heldCatalog;
    if (!held || catalogDeciding) return;
    setCatalogDeciding(true);
    try {
      const next = await configure({ action: choice === "accept" ? "catalog-accept" : "catalog-reject", revision: held.revision, digest: held.digest, sourceId: held.sourceId || undefined });
      if (!next) return;
      setHeldCatalog(null);
      if (choice === "accept") requestSessionRestart();
    }
    finally { setCatalogDeciding(false); }
  }
  // The runtime's terminal build refreshes its catalogs at startup. The desktop spoke
  // to the runtime in rpc mode, which skips that step, so a catalog published since the
  // last launch never reached a session. Refresh once per launch and rebind only when a
  // source actually activated a revision.
  useEffect(() => {
    if (!setup?.account.signedIn) return;
    void refreshModelCatalog();
    // refreshModelCatalog is stable for this purpose and self-gates with catalogAttempted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup?.account.signedIn]);
  useEffect(() => {
    if (restartPending && !chatBusy) { setRestartPending(false); setSessionRevision(value => value + 1); }
  }, [restartPending, chatBusy]);
  async function repairConsole(): Promise<boolean> {
    setRepair({ error: null });
    try { await invoke("terminal_install"); setRepair(null); return true; }
    catch (failure) { setRepair({ error: String(failure) }); return false; }
  }
  async function launchTerminal(path: string) {
    if (!state?.ready) return;
    setOperation("launching"); setError(null); setNotice(null);
    try {
      if (needsSetup) return;
      setOperation("launching");
      // A console this machine cannot draw correctly is repaired before Jouzu starts, not instead of it.
      if ((await invoke<boolean>("console_repair_needed").catch(() => false)) === true && !(await repairConsole())) return;
      await invoke("launch_jouzu", { path });
      setNotice("requested");
      await refresh();
    } catch (error) { fail("folders", error); } finally { setOperation(null); }
  }
  async function chooseFolder() {
    setOperation("choosing"); setError(null);
    try {
      const path = await open({ directory: true, multiple: false, title: t.picker });
      if (typeof path === "string") { await addFolders([path]); setActivePath(path); }
    } catch (error) { fail("folders", error); } finally { setOperation(null); }
  }
  async function forget(workspace: Workspace) {
    setOperation("saving"); setError(null);
    try {
      await api.workspaces.forget(workspace.id);
      const next = state?.recent.find(item => item.id !== workspace.id)?.path ?? null;
      if (activePath === workspace.path) setActivePath(next);
      await refresh();
      setNotice("removed");
    } catch (error) { fail("folders", error); } finally { setOperation(null); }
  }
  const recent = state?.recent.filter(item => item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  if (sort === "name") recent.sort((a,b) => a.path.replaceAll(String.fromCharCode(92), "/").split("/").at(-1)!.localeCompare(b.path.replaceAll(String.fromCharCode(92), "/").split("/").at(-1)!, locale));
  if (sort === "path") recent.sort((a,b) => a.path.localeCompare(b.path, locale));
  const development = components?.development ?? import.meta.env.DEV;
  const inlineProviders = !settingsOpen;
  const providerInfo = setup?.providers.find(item => item.id === provider);
  const providerOauth = connectionMode === "builtin" && provider === "openai-codex";
  const providerSignedIn = !!setup?.credentials.some(item => item.providerId === provider);
  // Shisa is an account, not a provider credential. Its saved key is shown by
  // the Shisa.AI card and must not appear again as a phantom provider row.
  const otherProviders = setup ? [...new Set([...setup.credentials.map(c => c.providerId), ...setup.customProviders.map(c => c.id)])].filter(id => id !== "shisa") : [];
  const providerApiKey = providerInfo?.apiKey !== false;
  const providerContent = <div className="space-y-4">                  {(inlineProviders || !addingConnection) && <><Card className={inlineProviders ? "gap-3 rounded-none border-0 bg-transparent p-0 shadow-none" : "border-border gap-4 py-5 shadow-none"}><CardHeader className={inlineProviders ? "px-0" : undefined}><CardTitle>Shisa.AI</CardTitle><CardDescription>{device ? t.waitingAuthorization : setup?.account.signedIn ? t.shisaConnected : t.shisaHint}</CardDescription></CardHeader><CardContent className={inlineProviders ? "space-y-3 px-0" : "space-y-3"}>{!device && setup?.account.revocation === "unconfirmed" && <p role="status" className="text-sm text-muted-foreground">{t.signOutUnconfirmed}</p>}{!device && <div className="flex flex-wrap justify-end gap-2">{setup?.account.signedIn && <Button variant="outline" disabled={busy || catalogRefreshing || !setup} onClick={() => void refreshModelCatalog(true)}><RefreshCw className={catalogRefreshing ? "animate-spin" : undefined} />{t.refreshModels}</Button>}<Button disabled={busy || !setup} onClick={() => void configure({ action: setup?.account.signedIn ? "shisa-logout" : "shisa-login" })}>{setup?.account.signedIn ? t.signOut : t.signIn}</Button></div>}{device && <div className="space-y-3"><Input readOnly aria-label={t.loginUrl} value={device.url} onFocus={event => event.target.select()} /><Input readOnly aria-label={t.deviceCode} value={device.code} onFocus={event => event.target.select()} /><p className="text-xs text-muted-foreground">{t.loginHint}</p><div className="flex items-center justify-end gap-2"><Button variant="outline" onClick={() => void controlCancel()}>{t.cancel}</Button><Button onClick={async () => { try { const url = new URL(device.url); if (url.origin !== "https://platform.shisa.ai" || url.pathname !== "/connect" || url.username || url.password) throw new Error(t.loginUrl); await openUrl(url.href); } catch (error) { fail("settings", error); } }}><ArrowUpRight />{t.openBrowser}</Button></div></div>}</CardContent></Card>
                  {!inlineProviders && <>                  <Card className="border-border gap-4 py-5 shadow-none"><CardHeader><CardTitle>{t.connections}</CardTitle></CardHeader><CardContent className="space-y-2">{!!setup && otherProviders.length > 5 && <Input aria-label={t.searchProviders} placeholder={t.searchProviders} value={providerQuery} onChange={event => setProviderQuery(event.target.value)} />}{!addingConnection && setup && otherProviders.filter(id => `${id} ${setup.providers.find(p => p.id === id)?.name ?? ""}`.toLowerCase().includes(providerQuery.toLowerCase())).map(id => ({providerId:id})).map(c => <div key={c.providerId} className="flex items-center gap-2"><Button variant="outline" className="h-auto min-w-0 flex-1 justify-between gap-2 py-3" disabled={busy} onClick={() => { setProvider(c.providerId); setToken(""); const saved = setup?.customProviders.find(p => p.id === c.providerId); setConnectionMode(saved?.editable ? "custom" : "builtin"); setCustom(saved?.editable ? {provider:saved.id,url:saved.url,model:saved.model,edit:true,imageInput:saved.imageInput ?? false,contextWindow:saved.contextWindow ?? 32768,maxTokens:saved.maxTokens ?? 4096} : {provider:"",url:"",model:"",edit:false,imageInput:false,contextWindow:32768,maxTokens:4096}); setAddingConnection(true); }}><span>{setup.providers.find(p => p.id === c.providerId)?.name ?? c.providerId}</span><span className="text-xs text-muted-foreground">{setup.credentials.some(key => key.providerId === c.providerId) ? t.credentialSaved : t.configuredNoKey}</span></Button></div>)}<Button variant="outline" disabled={busy || !setup} onClick={() => { setProviderQuery(""); setProvider(""); setConnectionMode("builtin"); setCustom({provider:"",url:"",model:"",edit:false,imageInput:false,contextWindow:32768,maxTokens:4096}); setAddingConnection(true); }}><Plus />{t.addConnection}</Button></CardContent></Card></>}</>}
                  {(inlineProviders || addingConnection) && <section className={inlineProviders ? "space-y-3 border-t border-border pt-4" : "space-y-4 rounded-xl border border-border bg-card p-5"}><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{inlineProviders ? t.connections : custom.edit ? t.editConnection : t.addConnection}</h3>{!inlineProviders && <Button variant="ghost" disabled={busy} onClick={() => setAddingConnection(false)}>{t.backConnections}</Button>}</div><div className="space-y-4">
                  <div className="space-y-2">{!inlineProviders && <Label>{t.service}</Label>}<ProviderPicker value={connectionMode === "custom" ? "__custom__" : provider} disabled={busy || custom.edit} label={t.service} placeholder={t.chooseService} searchLabel={t.searchProviders} empty={t.noResults} items={[...(setup?.providers ?? []),{id:"__custom__",name:t.customProvider}]} onChange={value => { setToken(""); if(value === "__custom__") {setConnectionMode("custom");setProvider("");} else {setConnectionMode("builtin");setProvider(value);} }}/></div>

                  {connectionMode === "builtin" && provider &&
                  <div className="space-y-4 border-t border-border pt-4">

                    {provider && <>{providerOauth && <div className="space-y-3 rounded-lg border border-border p-3"><p className="text-sm text-muted-foreground">{providerInfo?.oauthName ?? t.oauthHint}</p>{providerSignedIn ? <div className="flex items-center justify-between gap-2"><span className="text-sm">{t.oauthConnected}</span><Button variant="outline" disabled={busy} onClick={() => void configure({ action: "provider-remove", provider })}>{t.removeCredential}</Button></div> : <div className="flex justify-end"><Button disabled={busy} onClick={async () => { await configure({ action: "provider-oauth", provider }); }}>{t.oauthSignIn}</Button></div>}{providerDevice?.provider === provider && <div className="space-y-3"><Input readOnly aria-label={t.loginUrl} value={providerDevice.url} onFocus={event => event.target.select()} />{providerDevice.code && <Input readOnly aria-label={t.deviceCode} value={providerDevice.code} onFocus={event => event.target.select()} />}<p className="text-xs text-muted-foreground">{t.loginHint}</p><div className="flex items-center justify-end gap-2"><Button variant="outline" onClick={() => void controlCancel()}>{t.cancel}</Button><Button onClick={async () => { try { await openDeviceUrl(providerDevice.url); } catch (error) { fail("settings", error); } }}><ArrowUpRight />{t.openBrowser}</Button></div></div>}</div>}{providerApiKey && <><Label>{t.apiKey}</Label><Input type="password" autoComplete="off" aria-label={t.apiKey} placeholder={t.apiKey} value={token} onChange={event => setToken(event.target.value)} /><div className="flex justify-end gap-2"><Button disabled={busy || !token.trim()} onClick={async () => { if (await configure({ action: "provider-key", provider, token })) { setToken(""); setAddingConnection(false); } }}>{t.save}</Button>{setup?.credentials.some(c => c.providerId === provider) && <Button variant="outline" disabled={busy} onClick={() => void configure({ action: "provider-remove", provider })}>{t.removeCredential}</Button>}</div></>}
                    <Label>{t.defaultModel}</Label><Select value={setup?.defaultProvider === provider ? setup.defaultModel : ""} onValueChange={model => void configure({ action: "default-model", provider, model })}><SelectTrigger className="w-full" aria-label={t.defaultModel}><SelectValue placeholder={t.defaultModel} /></SelectTrigger><SelectContent>{setup?.models.filter(m => m.provider === provider).map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent></Select></>}
                  </div>}
                  {connectionMode === "custom" &&<div className="space-y-3 border-t border-border pt-4"><p className="text-sm text-muted-foreground">{t.customHint}</p><Label>{t.providerId}</Label><Input placeholder={t.providerId} aria-label={t.providerId} disabled={custom.edit} value={custom.provider} onChange={event => setCustom({...custom,provider:event.target.value})} /><Label>{t.endpoint}</Label><Input placeholder={t.endpoint} aria-label={t.endpoint} value={custom.url} onChange={event => setCustom({...custom,url:event.target.value})} /><Label>{t.modelId}</Label><Input placeholder={t.modelId} aria-label={t.modelId} value={custom.model} onChange={event => setCustom({...custom,model:event.target.value})} /><div className="flex items-center justify-between gap-3"><Label htmlFor="custom-image-input">{t.imageInput}</Label><Switch id="custom-image-input" checked={custom.imageInput} onCheckedChange={imageInput => setCustom(value=>({...value,imageInput}))} /></div><p className="text-xs text-muted-foreground">{t.imageInputHint}</p><Label>{t.contextWindow}</Label><Input type="number" min={1024} max={2000000} step={1024} aria-label={t.contextWindow} value={custom.contextWindow} onChange={event => setCustom(value=>({...value,contextWindow:Number(event.target.value)}))} /><p className="text-xs text-muted-foreground">{t.contextWindowHint}</p><Label>{t.maxOutput}</Label><Input type="number" min={1} max={custom.contextWindow} step={1} aria-label={t.maxOutput} value={custom.maxTokens} onChange={event => setCustom(value=>({...value,maxTokens:Number(event.target.value)}))} /><p className="text-xs text-muted-foreground">{t.maxOutputHint}</p><Label>{t.apiKey}</Label><Input type="password" autoComplete="off" aria-label={t.apiKey} placeholder={t.apiKey} value={token} onChange={event=>setToken(event.target.value)}/><div className="flex justify-end pt-1"><Button disabled={busy || !custom.provider || !custom.url || !custom.model} onClick={async () => { if (await configure({action:"custom-provider",...custom})) { setCustom(value=>({...value,edit:true})); if (token.trim() && !await configure({action:"provider-key",provider:custom.provider,token})) return; setToken("");setAddingConnection(false); } }}>{t.save}</Button></div></div>}
                  </div></section>}
</div>;
  // One banner for every first-run screen. `fill` lets the banner take the height
  // that a prepare or loading page would otherwise leave empty. The look is the
  // approved prepare page: cyan wash, one glow, mark and wordmark.
  const onboardingBanner = (title: string, action?: ReactNode, intensity = 0.55, fill = false, pageHeading = false) => <div className={`relative flex ${fill ? "min-h-0 flex-1" : "min-h-56 shrink-0"} items-center justify-center overflow-hidden border-b border-border bg-gradient-to-b from-primary/25 via-primary/5 to-background px-6`}>
    <div className="pointer-events-none absolute -top-32 size-[28rem] rounded-full bg-primary/20 blur-3xl transition-opacity duration-700 animate-[jouzu-glow_9s_ease-in-out_infinite]" style={{ opacity: intensity }} aria-hidden="true" />
    <div className="relative flex flex-col items-center gap-3 text-center">
      <img src={jouzuIcon} alt="" draggable={false} className="size-20 drop-shadow-lg" />
      <p className="text-2xl font-semibold tracking-tight">Jouzu Desktop</p>
      <h1 data-slot={pageHeading ? "page-heading" : undefined} className="text-sm font-normal text-muted-foreground">{title}</h1>
    </div>
    {action && <div className="absolute right-6 top-6">{action}</div>}
  </div>;
  // The first-run pages have no titlebar of their own; without these a loading
  // window cannot be closed.
  const firstRunControls = <div className="fixed right-2 top-2 z-50 flex items-center gap-1">{api.capabilities.native && <>
    <Button variant="ghost" aria-label={t.minimize} title={t.minimize} onClick={() => getCurrentWindow().minimize().catch(error => quiet(error))}><Minus /></Button>
    <Button variant="ghost" aria-label="Close launcher" title={t.dismiss} onClick={() => getCurrentWindow().close().catch(error => quiet(error))}><X /></Button>
  </>}</div>;
  // The one loading page: its title line says what is happening; a failure shows
  // below it with the detail to copy and a retry.
  const loadingScreen = (title: string, failure?: { message: string; detail: string; onRetry: () => void }) => <main className="fixed inset-0 z-40 flex h-screen w-full flex-col overflow-hidden bg-background">
    {firstRunControls}
    {onboardingBanner(title, undefined, 0.7, true)}
    <section aria-label={title} className="flex shrink-0 flex-col items-center gap-4 px-6 pb-14 pt-8">
      <span role="status" aria-live="polite" className="sr-only">{title}</span>
      <Progress value={null} className="w-full max-w-xl" />
      {failure && <div className="flex w-full max-w-xl flex-col items-center gap-3"><p className="text-sm text-muted-foreground" role="alert">{failure.message}</p><div className="flex w-full items-center gap-2 rounded-lg border border-border bg-card py-2 pl-3 pr-1"><code className="select-text min-w-0 flex-1 truncate text-xs text-muted-foreground" title={failure.detail}>{failure.detail}</code><Button variant="ghost" className="shrink-0" aria-label={t.copy} title={t.copy} onClick={() => void copyStatusError(failure.detail)}>{statusCopied ? <Check className="text-primary" /> : <Copy />}</Button></div><Button onClick={failure.onRetry}>{t.retry}</Button></div>}
    </section>
  </main>;
  const connectingScreen = loadingScreen(t.connecting, statusError ? { message: t.connectFailed, detail: statusError, onRetry: () => void readStatus() } : undefined);
  const preparePercent = prepare.phase === "node" && prepare.total ? Math.max(3, (prepare.downloaded / prepare.total) * 40) : prepare.phase === "packages" ? 55 : prepare.phase === "verify" ? 90 : prepare.phase === "tools" ? 95 : 6;
  // A launcher-style prepare page: banner, one bar, no choices. It belongs to the
  // runtime step of the same state machine.
  const prepareScreen = <main className="flex h-screen w-full flex-col overflow-hidden bg-background">
    {onboardingBanner(t.prepareTitle, undefined, 0.45 + preparePercent / 200, true)}
    <div className="flex shrink-0 justify-center px-6 pb-16 pt-8">
      <div className="w-full max-w-xl space-y-3">
        <div className="flex items-baseline justify-between"><span className="text-sm font-medium">{prepare.error ? t.prepareFailed : prepare.phase === "node" ? t.prepareNode : prepare.phase === "packages" ? t.preparePackages : prepare.phase === "verify" ? t.prepareVerify : prepare.phase === "tools" ? t.prepareTools : t.prepareTitle}</span><span className="text-xs text-muted-foreground">{prepare.phase === "node" && prepare.total ? `${Math.round(prepare.downloaded / 1048576)} / ${Math.round(prepare.total / 1048576)} MB` : ""}</span></div>
        <Progress value={prepare.phase === "packages" && !prepare.error ? null : preparePercent} className="h-2.5" />
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span className="break-all">{prepare.error ? prepare.error : t.prepareHint}</span>{prepare.error && <Button variant="outline" onClick={() => void runPrepare()}>{t.retry}</Button>}</div>
      </div>
    </div>
  </main>;
  // No language step: the one setup page left is connecting a model.
  const modelSetupScreen = <main className="flex h-screen w-full flex-col overflow-hidden bg-background">
    {firstRunControls}
    {onboardingBanner(t.setupConnect, undefined, 0.55, false, true)}
    <div className="flex min-h-0 flex-1 justify-center overflow-auto px-6 py-8">
      <div data-slot="page-body" className="onboarding-card m-auto w-full max-w-2xl rounded-2xl border border-border bg-card/70 p-6 shadow-[0_28px_70px_-40px_rgba(0,0,0,0.95)] backdrop-blur-sm sm:p-8">
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">{t.setupHint}</p>
        {error?.place === "settings" && <div className="mb-4">{errorNotice("settings")}</div>}
        {providerContent}
      </div>
    </div>
  </main>;
  if (runtimePresent === null) return connectingScreen;
  if (runtimePresent === false) return prepareScreen;
  if (setup && setup.modelReady === false) return modelSetupScreen;
  return <main aria-busy={busy || undefined} className="flex h-screen w-full flex-col overflow-hidden">
    <span role="status" aria-live="polite" className="sr-only">{busy || notice ? (operation === "preparing" ? t.preparing : operation === "launching" ? t.launching : operation === "choosing" ? t.choosing : operation === "saving" ? t.saving : notice ? t[notice] : null) : state && !state.ready ? t.repair : ""}</span>
    <header data-tauri-drag-region className="flex items-center justify-between border-b border-border px-4 py-2">
      <div className="absolute left-0 right-0 top-0 h-3" data-tauri-drag-region />
      <div className="pointer-events-none flex items-center gap-2"><img src={jouzuIcon} alt="" draggable={false} className="size-7" /><h1 className="min-w-16 flex-1 text-sm font-semibold tracking-tight">Jouzu</h1>{import.meta.env.DEV && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">DEV</span>}</div>
      <div className="pointer-events-none flex items-center gap-1 [&>*]:pointer-events-auto"><Dialog modal={false} open={settingsOpen} onOpenChange={value => { if (!value && device) void controlCancel(); if (!value) setUpdateFocus(null); setSettingsOpen(value); }}>
        {/* The dialog must stay open on an outside click and must not let the view behind it be used. A non-modal dialog keeps the background interactive, so shield it. */}
        {settingsOpen && <div aria-hidden="true" data-settings-shield className="fixed inset-0 z-40" onPointerDown={event => event.preventDefault()} onWheel={event => event.preventDefault()} />}
        <DialogContent showCloseButton={false} onInteractOutside={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()} className="flex h-[min(560px,85dvh)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border-border p-0 sm:max-w-3xl">
          {error?.place === "settings" && <div className="border-b border-border p-2">{errorNotice("settings")}</div>}
          <DialogDescription className="sr-only">{t.preferences}</DialogDescription>
          <Tabs value={settingsTab} onValueChange={setSettingsTab} orientation="vertical" className="min-h-0 flex-1 gap-0">
            <aside className="w-36 shrink-0 border-r border-border bg-muted/60 p-3 sm:w-48">
              <DialogTitle className="mb-5 flex items-center gap-2 px-2 pt-2 text-sm font-semibold"><Settings className="size-4" />{t.settings}<DialogClose asChild><Button variant="ghost" className="ml-auto size-7 shrink-0 p-0" aria-label={t.dismiss}><X className="size-4" /></Button></DialogClose></DialogTitle>
              <TabsList aria-label={t.settings} className="h-auto w-full items-stretch gap-1 bg-transparent p-0">
                <TabsTrigger value="providers" className="min-h-10 justify-start gap-2 px-3"><KeyRound className="size-4 shrink-0" aria-hidden="true" />{t.providers}</TabsTrigger>
                <TabsTrigger value="tools" className="min-h-10 justify-start gap-2 px-3"><Wrench className="size-4 shrink-0" aria-hidden="true" />{t.toolsTab}</TabsTrigger>
                <TabsTrigger value="appearance" className="min-h-10 justify-start gap-2 px-3"><Palette className="size-4 shrink-0" aria-hidden="true" />{t.appearance}</TabsTrigger>
                <TabsTrigger value="environment" className="min-h-10 justify-start gap-2 px-3"><SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />{t.environment}</TabsTrigger><TabsTrigger value="general" className="min-h-10 justify-start gap-2 px-3"><Languages className="size-4 shrink-0" aria-hidden="true" />{t.general}</TabsTrigger>
                <TabsTrigger value="system" className="min-h-10 justify-start gap-2 whitespace-normal px-3 text-left"><RefreshCw className="size-4 shrink-0" aria-hidden="true" />{t.system}</TabsTrigger>
              </TabsList>
            </aside>
            <ScrollArea className="min-w-0 flex-1">
              <div className="px-5 pb-6 pt-14 sm:px-6">
                <TabsContent value="providers" className="m-0 space-y-4">
                  {providerContent}
                  
                </TabsContent>
                <TabsContent value="tools" className="m-0 space-y-4"><ToolsPanel /></TabsContent>
                <TabsContent value="environment" className="m-0 space-y-4"><Card className="border-border shadow-none"><CardHeader><CardTitle>{t.environment}</CardTitle><CardDescription>{t.envHint}</CardDescription></CardHeader><CardContent className="space-y-3">
                  {envRows.map((row,index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3"><div className="flex items-center gap-2">{editingEnv === index ? <Input aria-label={t.variableName} placeholder={t.variableName} value={row.name} disabled={busy} onChange={event => setEnvRows(rows => rows.map((r,i) => i === index ? {...r,name:event.target.value} : r))} /> : <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.name}>{row.name}</span>}<Button variant="ghost" disabled={busy} onClick={() => setEditingEnv(index)}>{t.editValue}</Button><Switch aria-label={t.enabled} checked={row.enabled} disabled={busy} onCheckedChange={enabled => setEnvRows(rows => rows.map((r,i) => i === index ? {...r,enabled} : r))} /><Button variant="ghost" disabled={busy} aria-label={t.deleteEntry} onClick={() => { setEnvRows(rows => rows.filter((_,i) => i !== index)); setEditingEnv(null); }}><X /></Button></div>{editingEnv === index && <Input type="password" autoComplete="off" aria-label={t.variableValue} placeholder={t.variableValue} value={row.value} disabled={busy} onChange={event => setEnvRows(rows => rows.map((r,i) => i === index ? {...r,value:event.target.value} : r))} />}</div>)}
                  <div className="flex gap-2"><Button variant="outline" disabled={!envLoaded || busy} onClick={() => { setEditingEnv(envRows.length); setEnvRows(rows => [...rows,{name:"",value:"",enabled:true}]); }}><Plus />{t.addEntry}</Button><Button className="ml-auto" disabled={!envLoaded || busy} onClick={saveEnvironment}>{t.save}</Button></div>
                </CardContent></Card></TabsContent>
                <TabsContent value="appearance" className="m-0 space-y-4">
                  <Card className="border-border shadow-none"><CardHeader><CardTitle>{t.appearance}</CardTitle><CardDescription>{t.appearanceHint}</CardDescription></CardHeader><CardContent>
                    <Select value={theme} onValueChange={value => setTheme(value as Theme)}><SelectTrigger aria-label={t.appearance} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">{t.themeSystem}</SelectItem><SelectItem value="dark">{t.themeDark}</SelectItem><SelectItem value="light">{t.themeLight}</SelectItem></SelectContent></Select>
                  </CardContent></Card>
                </TabsContent>
                <TabsContent value="general" className="m-0 space-y-4">
                  <Card className="border-border shadow-none"><CardHeader><CardTitle>{t.language}</CardTitle><CardDescription>{t.languageHint}</CardDescription></CardHeader><CardContent>
                    <Select value={locale} onValueChange={value => setLocale(value as Locale)}><SelectTrigger aria-label={t.language} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(locales).map(([key,label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select>
                    <div className="mt-6 space-y-3 border-t border-border pt-5">
                      <div className="flex items-center justify-between gap-4"><Label htmlFor="japanese-first">{t.profile}</Label><Switch id="japanese-first" disabled={busy || !setup} checked={setup?.profile === "ja"} aria-describedby="japanese-first-description" onCheckedChange={enabled => void configure({ action: "profile", profile: enabled ? "ja" : "core" })} /></div>
                      <p id="japanese-first-description" className="text-sm leading-relaxed text-muted-foreground">{t.profileHint}</p>
                      <p className="text-sm leading-relaxed text-muted-foreground">{t.profileOffHint}</p>
                    </div>
                  </CardContent></Card>

                </TabsContent>
                <TabsContent value="system" className="m-0 space-y-4">
                  
                  <UpdatePreview locale={locale} focusIndex={updateFocus} live={{
                    phases:[jouzuUpdater.phase === 'preparing' || jouzuUpdater.phase === 'verifying' || jouzuUpdater.phase === 'activating' || jouzuUpdater.phase === 'staged' ? 'installing' : jouzuUpdater.phase as 'idle'|'checking'|'available'|'current'|'downloading'|'installing'|'complete'|'error', updater.phase],
                    versions:[components?.jouzu ?? t.unavailable, version ? (components?.commit && components.commit !== 'unknown' ? `${version} · ${components.commit} · ${components.build ?? ''}` : version) : t.unavailable],
                    targets:[jouzuUpdater.version,updater.version],
                    progress:jouzuUpdater.busy?jouzuUpdater.progress:updater.progress,
                    configured:[!!components?.jouzuUpdaterConfigured,!!components?.launcherUpdaterConfigured],
                    errors:[jouzuUpdater.error,updater.error],
                    notes:[jouzuUpdater.notes ?? '',updater.notes ?? ''],
                    sources:[jouzuUpdater.notesSource ?? '', ''],
                    channel: updater.channel && components?.launcherUpdaterConfigured ? { value: updater.channel, set: value => void updater.setChannel(value), downgrade: updater.downgrade } : undefined,
                    repair: components?.jouzu || import.meta.env.DEV ? undefined : { label: recoveryText[locale].action, run: () => { void (async () => {
                      if (!await confirm(recoveryText[locale].description, {title: recoveryText[locale].title, kind: "warning"})) return;
                      setOperation("saving"); setError(null);
                      try { await invoke("repair_jouzu"); setComponents(await invoke<Components>("component_versions")); await refresh(); await refreshDiagnostics(); }
                      catch (failure) { fail("settings", failure); } finally { setOperation(null); }
                    })(); } },
                    check:()=>{void jouzuUpdater.check();void updater.refresh();},
                    install:index=>{if(index===0)void jouzuUpdater.install();else void updater.install();}
                  }}/>
                  {state?.platform === "windows" && <div className="rounded-lg border border-border"><GitBashSection locale={locale} api={gitBash} /><TerminalSection locale={locale} /><CommandEntrySection locale={locale} /></div>}
                  {diagnostics !== null && diagnostics.crashes.length > 0 && <Card className="border-border shadow-none">
                    <CardHeader><CardTitle>{t.crashTitle}</CardTitle><CardDescription>{t.crashHint}</CardDescription></CardHeader>
                    <CardContent className="space-y-3">{diagnostics.crashes.map(record => <div key={record.path} className="space-y-1 rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">{new Date(record.time * 1000).toLocaleString()} | {record.version} | {record.location}</p>
                      <p className="break-words text-sm">{record.message}</p>
                      <div className="flex justify-end"><Button variant="ghost" onClick={async()=>{ try { await invoke("crash_dismiss",{path:record.path}); } finally { await refreshDiagnostics(); } }}>{t.dismiss}</Button></div>
                    </div>)}</CardContent>
                  </Card>}
                  <ReportSection locale={locale} />
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        </DialogContent>
      </Dialog>
      {api.capabilities.native && <><Button variant="ghost" aria-label={t.minimize} onClick={() => getCurrentWindow().minimize().catch(error => quiet(error))}><Minus /></Button><Button variant="ghost" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => getCurrentWindow().toggleMaximize().catch(error => quiet(error))}>{maximized ? <Minimize2 /> : <Maximize2 />}</Button><Button variant="ghost" aria-label="Hide to tray" title="Hide to tray" onClick={() => getCurrentWindow().close().catch(error => quiet(error))}><X /></Button></>}
      </div>
    </header>
      <Dialog open={repair !== null} onOpenChange={open => { if (!open) setRepair(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>{t.consoleRepairTitle}</DialogTitle>
          <DialogDescription>{t.consoleRepairHint}</DialogDescription>
          <div className="flex items-center gap-3">
            {!repair?.error && <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><span className="flex size-4 items-center justify-center"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /></span>{t.installingUpdate}</span>}
            {repair?.error && <p role="alert" className="text-sm text-destructive">{t.consoleRepairFailed}</p>}
            <div className="ml-auto flex gap-2">{repair?.error && <Button onClick={() => void repairConsole()}>{t.retry}</Button>}</div>
          </div>
        </DialogContent>
      </Dialog>
      {/* A held catalog revision is a decision. The desktop shows its own
          confirmation; it never prints terminal instructions or shells out to the
          runtime's catalog command. Escape or an outside click defers the decision. */}
      <Dialog open={heldCatalog !== null} onOpenChange={open => { if (!open) setHeldCatalog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{review.title}</DialogTitle>
          <DialogDescription>{review.hint}</DialogDescription>
          {heldCatalog && heldCatalog.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {heldCatalog.reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>}
          {heldCatalog && catalogChangeSummary(heldCatalog.changes) && <p className="text-sm">{catalogChangeSummary(heldCatalog.changes)}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={catalogDeciding} onClick={() => void decideHeldCatalog("reject")}>{review.reject}</Button>
            <Button disabled={catalogDeciding} onClick={() => void decideHeldCatalog("accept")}>{review.accept}</Button>
          </div>
        </DialogContent>
      </Dialog>
      {entryBooting && !entryReady.current && loadingScreen(
        entryWarm?.state === "starting" && entryWarm.since !== null ? t.warming.replace("{s}", String(Math.max(0, Math.round((bootNow - entryWarm.since) / 1000)))) : t.connecting,
        entryWarm?.state === "failed" ? { message: t.warmingFailed, detail: entryWarm.error ?? "", onRetry: () => retryEntryWarm.current() } : undefined,
      )}
    {activePath && <div className="flex min-h-0 flex-1">
      <ChatWorkspace
        path={activePath}
        revision={sessionRevision}
        newSession={newSession}
        onStartSession={() => setNewSession(false)}
        onRetry={() => setSessionRevision(value => value + 1)}
        onBusyChange={setChatBusy}
        onBootChange={(booting, warm, retryWarm) => {
          setEntryWarm(warm);
          retryEntryWarm.current = retryWarm;
          setEntryBooting(booting);
          if (!booting && !entryReady.current) requestAnimationFrame(() => api.runtime.mark?.("loading.ready"));
          if (!booting) entryReady.current = true;
        }}
        catalogRefreshing={catalogRefreshing}
        canRefreshModels={setup?.account.signedIn === true}
        onModelsMissing={() => void refreshModelCatalog()}
        onRetryModels={() => void refreshModelCatalog(true)}
        workspaces={state?.recent ?? []}
        onSelect={setActivePath}
        onAddFolder={() => void chooseFolder()}
        onRemove={id => { const workspace = state?.recent.find(item => item.id === id); if (workspace) void forget(workspace); }}
        folderNotice={errorNotice("folders")}

        onSettings={() => setSettingsOpen(true)}
        onUpdate={openUpdatePanel}
        updateAvailable={!!(updater.version || jouzuUpdater.version)}
        updateBusy={updater.busy || jouzuUpdater.busy}
      />
    </div>}
    {!activePath && <LauncherPage title={t.heading} description={t.intro}>
      {error?.place === "folders" && <div className="mx-auto w-full max-w-xl px-6 pt-6">{errorNotice("folders")}</div>}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6"><Button onClick={() => void chooseFolder()} disabled={!state || busy}><Plus />{t.addFolder}</Button><Button variant="outline" onClick={() => setSettingsOpen(true)}>{t.settings}</Button></div>
    </LauncherPage>}
    </main>;
}
























