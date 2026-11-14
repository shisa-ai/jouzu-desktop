/**
 * Sibling platform adapters. They all extend JouzuApi directly; components only
 * see the abstract parent. Platform differences are capabilities, not UI branches.
 */

import { HostClient } from "./host-client";
import { createDesktopBridge, type DesktopBridge } from "./desktop-bridge";
import {
  ApiError,
  CapabilityUnavailable,
  JouzuApi,
  type ApiCapabilities,
  type ApiEvent,
  type ArtifactApi,
  type CommandApi,
  type FileApi,
  type McpApi,
  type ModelApi,
  type ToolsApi,
  type NativeApi,
  type PromptApi,
  type RuntimeApi,
  type SessionApi,
  type SettingsApi,
  type Unsubscribe,
  type WorkspaceApi,
} from "./jouzu-api";

function unsupported(): never {
  throw new ApiError("invalid-request", "This action is not available in this version of Jouzu.", false);
}

function unavailableNative(): NativeApi {
  const fail = async (): Promise<never> => {
    throw new CapabilityUnavailable();
  };
  return {
    confirm: async options =>
      typeof window !== "undefined" ? window.confirm(options.message) : false,
    pickFolder: fail,
    saveFile: fail,
    onFileDrop: () => () => {},
    reveal: fail,
    openExternal: fail,
    terminal: fail,
    installTerminal: fail,
    updater: { check: fail, install: fail },
  };
}

function hostGroups(client: HostClient) {
  const sessions: SessionApi = {
    list: () => client.sessions(),
    attach: (workspacePath, sessionPath) => client.attach(workspacePath, sessionPath),
    view: sessionId => client.view(sessionId),
    history: (sessionId, page) => client.history(sessionId, page),
    messages: (sessionPath, limit) => client.messages(sessionPath, limit),
    sanitizeImages: sessionPath => client.sanitizeSessionImages(sessionPath),
    send: (sessionId, message) =>
      client.send(sessionId, message.text, message.clientMessageId, message.attachments ?? []),
    async interrupt(sessionId) {
      await client.interrupt(sessionId);
    },
    async cancel(sessionId, clientMessageId) {
      await client.cancel(sessionId, clientMessageId);
    },
    async queue(sessionId, action) {
      await client.queue(sessionId, action);
    },
    async stop(sessionId) {
      await client.stop(sessionId);
    },
    update: (sessionPath, change) => client.updateSession(sessionPath, change),
    branch: (sessionPath, messageIndex) => client.branch(sessionPath, messageIndex),
    recover: sessionPath => client.recover(sessionPath),
    timing: async sessionPath => (await client.timing(sessionPath)) as never,
    flowReports: async sessionPath => (await client.flowReports(sessionPath)) as never,
  };

  const prompts: PromptApi = {
    async approve(approvalId, decision) {
      await client.approve(approvalId, decision);
    },
    async answer(questionId, answers) {
      await client.answer(questionId, answers);
    },
  };

  const runtime: RuntimeApi = {
    status: () => client.status(),
    warm: workspacePath => client.warm(workspacePath),
    warmState: waitMs => client.warmState(waitMs),
    mark: (mark, ids) => client.mark(mark, ids),
    components: async () => ({}),
    diagnostics: async () => null,
  };

  const workspaces: WorkspaceApi = {
    list: () => client.workspaces(),
    add: paths => client.addWorkspaces(paths),
    forget: id => client.forgetWorkspace(id),
  };

  const models: ModelApi = {
    async list() {
      return (await client.models()).models;
    },
    async select(sessionId, provider, model) {
      await client.selectModel(sessionId, provider, model);
    },
    async thinking(sessionId, level) {
      await client.setThinking(sessionId, level);
    },
  };

  const tools: ToolsApi = {
    settings: () => client.tools(),
    save: image => client.saveTools(image),
    providers: () => client.toolProviders(),
    models: provider => client.toolModels(provider),
  };

  const mcp: McpApi = {
    servers: () => client.mcp(),
  };

  const commands: CommandApi = {
    async run(sessionId, command) {
      await client.send(sessionId, command, `cmd-${crypto.randomUUID()}`);
    },
    stats: sessionId => client.stats(sessionId),
    async compact(sessionId) {
      await client.compact(sessionId);
    },
    async exportHtml(sessionId, outputPath) {
      await client.exportHtml(sessionId, outputPath);
    },
    async reload(sessionId) {
      await client.reload(sessionId);
    },
  };

  const artifacts: ArtifactApi = {
    list: options => client.artifacts(options),
    read: id => client.artifact(id),
    async delete(id) {
      await client.deleteArtifact(id);
    },
    counts: () => client.artifactCounts(),
  };

  const files: FileApi = {
    list: path => client.files(path),
    snapshot: path => client.workspaceSnapshot(path),
    readFile: path => client.readFile(path),
    async reveal() {
      throw new CapabilityUnavailable();
    },
  };

  const settings: SettingsApi = {
    environment: {
      read: () => client.environment(),
      async save(entries) {
        await client.saveEnvironment(entries);
      },
    },
    async control() {
      unsupported();
    },
  };

  return {
    sessions,
    prompts,
    runtime,
    workspaces,
    models,
    tools,
    mcp,
    commands,
    artifacts,
    files,
    settings,
    native: unavailableNative(),
  };
}

function assignHostGroups(api: JouzuApi, client: HostClient): void {
  Object.assign(api as unknown as Record<string, unknown>, hostGroups(client));
}

export class WebApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["chat", "sse", "replay", "prompts", "history-paging"],
    scopes: ["loopback"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly tools!: ToolsApi;
  readonly mcp!: McpApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient) {
    super();
    assignHostGroups(this, client);
  }

  async start(): Promise<void> {
    const capabilities = await this.client.capabilities();
    this.capabilities.features = capabilities.features ?? this.capabilities.features;
    this.capabilities.scopes = capabilities.scopes ?? this.capabilities.scopes;
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export class RemoteApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["chat", "sse", "replay", "prompts", "history-paging"],
    scopes: ["lan", "tailnet"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly tools!: ToolsApi;
  readonly mcp!: McpApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient) {
    super();
    assignHostGroups(this, client);
  }

  async start(): Promise<void> {
    const capabilities = await this.client.capabilities();
    this.capabilities.features = capabilities.features ?? this.capabilities.features;
    this.capabilities.scopes = capabilities.scopes ?? this.capabilities.scopes;
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export class DesktopApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["chat", "sse", "replay", "prompts", "history-paging"],
    scopes: ["loopback"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly tools!: ToolsApi;
  readonly mcp!: McpApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient, bridge?: DesktopBridge) {
    super();
    assignHostGroups(this, client);
    if (bridge) {
      Object.assign(this as unknown as Record<string, unknown>, {
        native: bridge.native,
        capabilities: { ...this.capabilities, native: true },
      });
    }
  }

  async start(): Promise<void> {
    const capabilities = await this.client.capabilities();
    this.capabilities.features = capabilities.features ?? this.capabilities.features;
    this.capabilities.scopes = capabilities.scopes ?? this.capabilities.scopes;
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export function createJouzuApi(client = new HostClient()): JouzuApi {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return new DesktopApi(client, createDesktopBridge());
  }
  return new WebApi(client);
}



