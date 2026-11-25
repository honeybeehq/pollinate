import { connect } from "node:net";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { parseTriggerRecord, parseTriggerToml } from "./config.js";
import { EventsRequestError, serveEvents, type TriggerTagIndex } from "./events.js";
import { MAX_SOCKET_PATH_BYTES, isEnoent } from "./fsx.js";
import { isValidStoreId, TriggerExistsError, type PollinateStore } from "./store.js";
import {
  API_ERROR_STATUS,
  API_FEATURES,
  type ApiErrorCode,
  type HealthResponse,
  type PollFirstCheck,
  type PutTriggerResponse,
  type TriggerState,
  type TriggerView,
  type WebhookRoute,
} from "./api-types.js";
import type { PollCheck } from "./poll.js";
import { API_VERSION, readBuildInfo, type BuildInfo } from "./version.js";
import type { DaemonConfig, Job, JobStatus, JsonValue, SourceKind, Trigger } from "./types.js";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 1_000;
const JOB_STATUSES: JobStatus[] = ["queued", "resolving-context", "running", "retrying", "completed", "errored", "timed-out", "cancelled"];
const SOURCE_KINDS: SourceKind[] = ["schedule", "poll", "webhook", "manual"];

export type ApiHost = {
  readonly store: PollinateStore;
  readonly startedAt: string;
  readonly reloadedAt: string;
  config(): DaemonConfig;
  webhookAddress(): { address: string; port: number } | null;
  triggers(): Trigger[];
  trigger(id: string): Trigger | undefined;
  preflightPoll(trigger: Trigger): Promise<string>;
  applyTrigger<T extends Trigger | null>(id: string, write: () => Promise<T>, fetchedPoll?: string): Promise<{ stored: T; poll?: PollCheck }>;
  scheduleState(id: string): { nextFireAt?: string; lastFireAt?: string };
  fire(trigger: Trigger, payload: JsonValue, deliveryId?: string): Promise<{ job: Job | null; duplicate: boolean }>;
  hive(): { path: string; version: string | null } | undefined;
  readonly eventTags: TriggerTagIndex;
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: JsonValue,
    readonly status = API_ERROR_STATUS[code],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class SocketPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketPathError";
  }
}

type Route = {
  method: string;
  pattern: RegExp;
  handle?: (request: ApiRequest) => Promise<unknown>;
  stream?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;
  status?: number;
};

type ApiRequest = {
  id: string;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
};

export class ApiServer {
  private server?: http.Server;
  private stopping = false;
  private listening = false;
  private buildInfo?: Promise<BuildInfo>;
  private readonly routes: Route[];

  constructor(
    private readonly host: ApiHost,
    readonly socketPath: string,
  ) {
    this.routes = [
      { method: "GET", pattern: /^\/v1\/health$/, handle: () => this.health() },
      { method: "GET", pattern: /^\/v1\/triggers$/, handle: (request) => this.listTriggers(request.query) },
      { method: "PUT", pattern: /^\/v1\/triggers\/([^/]+)$/, handle: (request) => this.putTrigger(request) },
      { method: "GET", pattern: /^\/v1\/triggers\/([^/]+)$/, handle: (request) => this.getTrigger(request.id) },
      { method: "PATCH", pattern: /^\/v1\/triggers\/([^/]+)$/, handle: (request) => this.patchTrigger(request) },
      { method: "DELETE", pattern: /^\/v1\/triggers\/([^/]+)$/, handle: (request) => this.deleteTrigger(request.id) },
      { method: "POST", pattern: /^\/v1\/triggers\/([^/]+)\/fire$/, handle: (request) => this.fire(request) },
      { method: "GET", pattern: /^\/v1\/jobs$/, handle: (request) => this.listJobs(request.query) },
      { method: "GET", pattern: /^\/v1\/jobs\/([^/]+)$/, handle: (request) => this.getJob(request.id) },
      { method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/cancel$/, handle: (request) => this.cancelJob(request.id) },
      { method: "GET", pattern: /^\/v1\/events$/, stream: (request, response, url) => this.events(request, response, url) },
      { method: "GET", pattern: /^\/v1\/doctor$/, handle: () => this.unsupported("GET /v1/doctor is not available in this build") },
    ];
  }

  async prepare(): Promise<void> {
    if (Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new SocketPathError(
        `API socket path is ${Buffer.byteLength(this.socketPath)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte Unix socket limit: ${this.socketPath}; set POLLINATE_SOCKET to a shorter path`,
      );
    }
    await this.clearStaleSocket();
  }

  async start(): Promise<void> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.listening = true;
    await chmod(this.socketPath, 0o600);
  }

  beginStopping(): void {
    this.stopping = true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 1_000).unref();
    });
    if (this.listening) await unlink(this.socketPath).catch(() => undefined);
    this.listening = false;
  }

  private async clearStaleSocket(): Promise<void> {
    const info = await lstat(this.socketPath).catch((error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isSocket()) throw new SocketPathError(`API socket path ${this.socketPath} exists and is not a socket; remove it or set POLLINATE_SOCKET`);
    if (await socketAnswers(this.socketPath)) {
      throw new SocketPathError(`API socket ${this.socketPath} is in use by another process; set POLLINATE_SOCKET to a different path`);
    }
    await unlink(this.socketPath).catch((error: unknown) => {
      if (!isEnoent(error)) throw error;
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.stopping) throw new ApiError("stopping", "the daemon is stopping");
      const url = new URL(request.url ?? "/", "http://pollinate");
      const method = request.method ?? "GET";
      let pathMatched = false;
      for (const route of this.routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        if (route.stream) {
          await route.stream(request, response, url);
          return;
        }
        if (!route.handle) continue;
        const id = match[1] === undefined ? "" : safeDecode(match[1]);
        const result = await route.handle({ id, query: url.searchParams, body: () => readJsonBody(request) });
        sendJson(response, route.status ?? 200, result);
        return;
      }
      if (pathMatched) throw new ApiError("unsupported", `${method} is not allowed on ${url.pathname}`, undefined, 405);
      throw new ApiError("not_found", `no route ${method} ${url.pathname}`);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "internal") {
        await this.host.store
          .appendLedger({ event: "pollinate.api.errored", method: request.method, path: request.url, error: apiError.message })
          .catch(() => undefined);
      }
      sendJson(response, apiError.status, {
        error: { code: apiError.code, message: apiError.message, ...(apiError.details === undefined ? {} : { details: apiError.details }) },
      });
    }
  }

  private async events(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      await serveEvents(request, response, url, { root: this.host.store.root, tags: this.host.eventTags });
    } catch (error) {
      if (error instanceof EventsRequestError) throw new ApiError("invalid_request", error.message);
      throw error;
    }
  }

  private unsupported(message: string): Promise<never> {
    return Promise.reject(new ApiError("unsupported", message));
  }

  private async health(): Promise<HealthResponse> {
    this.buildInfo ??= readBuildInfo();
    const info = await this.buildInfo;
    const config = this.host.config();
    const triggers = this.host.triggers();
    const hive = this.host.hive();
    return {
      name: "pollinate",
      version: info.version,
      commit: info.commit,
      api: API_VERSION,
      features: [...API_FEATURES],
      pid: process.pid,
      startedAt: this.host.startedAt,
      reloadedAt: this.host.reloadedAt,
      store: this.host.store.root,
      triggers: { total: triggers.length, enabled: triggers.filter((trigger) => trigger.enabled).length },
      webhook: { bind: config.webhook.bind, port: this.host.webhookAddress()?.port ?? config.webhook.port, publicUrl: config.webhook.publicUrl ?? null },
      ...(hive ? { hive } : {}),
    };
  }

  private async listTriggers(query: URLSearchParams): Promise<{ triggers: TriggerView[] }> {
    const tag = query.get("tag");
    const source = query.get("source");
    const enabled = query.get("enabled");
    if (source !== null && !SOURCE_KINDS.includes(source as SourceKind)) {
      throw new ApiError("invalid_request", `source must be one of ${SOURCE_KINDS.join(", ")}`);
    }
    const wantEnabled = enabled === null ? undefined : parseBooleanParam("enabled", enabled);
    const triggers = this.host
      .triggers()
      .filter((trigger) => tag === null || trigger.tags.includes(tag))
      .filter((trigger) => source === null || trigger.source.kind === source)
      .filter((trigger) => wantEnabled === undefined || trigger.enabled === wantEnabled)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { triggers: await this.views(triggers) };
  }

  private async getTrigger(id: string): Promise<{ trigger: TriggerView }> {
    const trigger = this.requireLoaded(id);
    const [view] = await this.views([trigger]);
    return { trigger: view! };
  }

  private async views(triggers: Trigger[]): Promise<TriggerView[]> {
    if (triggers.length === 0) return [];
    const [latest, health] = await Promise.all([
      this.host.store.latestJobsByTrigger(new Set(triggers.map((trigger) => trigger.id))),
      this.host.store.readTriggerHealth(),
    ]);
    return triggers.map((trigger) => {
      const schedule = this.host.scheduleState(trigger.id);
      const job = latest.get(trigger.id);
      const state: TriggerState = {
        nextFireAt: trigger.enabled && trigger.source.kind === "schedule" ? (schedule.nextFireAt ?? null) : null,
        lastFireAt: schedule.lastFireAt ?? null,
        lastJob: job ? { id: job.id, status: job.status, error: job.error ?? null } : null,
        consecutiveFailures: health[trigger.id]?.consecutiveFailures ?? 0,
        deliveries: trigger.lifecycle?.deliveries ?? 0,
      };
      return { ...trigger, state };
    });
  }

  private async putTrigger(request: ApiRequest): Promise<PutTriggerResponse> {
    const id = requireId(request.id);
    const ifAbsent = parseBooleanParam("ifAbsent", request.query.get("ifAbsent") ?? "0");
    const trigger = parseTriggerBody(await request.body(), id);
    if (ifAbsent && (this.host.trigger(id) || (await this.host.store.getTrigger(id).catch(() => true)))) {
      throw new ApiError("conflict", `trigger "${id}" already exists`, { id });
    }
    let fetchedPoll: string | undefined;
    if (trigger.enabled && trigger.source.kind === "poll") {
      try {
        fetchedPoll = await this.host.preflightPoll(trigger);
      } catch (error) {
        throw new ApiError("poll_failed", `first poll check failed: ${errorMessage(error)}`, { id, error: errorMessage(error) });
      }
    }
    let created = false;
    const write = async () => {
      try {
        const put = await this.host.store.putTrigger(trigger, { ifAbsent });
        created = put.created;
        return put.trigger;
      } catch (error) {
        if (error instanceof TriggerExistsError) throw new ApiError("conflict", `trigger "${id}" already exists`, { id });
        throw error;
      }
    };
    const applied = await this.host.applyTrigger(id, write, fetchedPoll);
    const loaded = this.host.trigger(id) ?? applied.stored;
    const response: PutTriggerResponse = { trigger: loaded, created, loaded: true };
    if (loaded.source.kind === "schedule") response.schedule = { nextFireAt: loaded.enabled ? (this.host.scheduleState(id).nextFireAt ?? null) : null };
    const route = this.webhookRoute(loaded);
    if (route) response.webhook = route;
    if (applied.poll) response.poll = pollCheckView(applied.poll);
    return response;
  }

  private async patchTrigger(request: ApiRequest): Promise<{ trigger: TriggerView }> {
    const id = requireId(request.id);
    const body = await request.body();
    if (typeof body.enabled !== "boolean") throw new ApiError("invalid_request", 'body must be {"enabled": true|false}');
    if (!(await this.host.store.getTrigger(id))) throw new ApiError("not_found", `no trigger "${id}"`);
    const enabled = body.enabled;
    await this.host.applyTrigger(id, async () => {
      await this.host.store.setTriggerEnabled(id, enabled).catch((error: unknown) => {
        throw notFoundOr(error, id);
      });
      return this.host.store.requireTrigger(id);
    });
    return this.getTrigger(id);
  }

  private async deleteTrigger(id: string): Promise<{ removed: string }> {
    requireId(id);
    if (!(await this.host.store.getTrigger(id).catch(() => true))) throw new ApiError("not_found", `no trigger "${id}"`);
    await this.host.applyTrigger(id, async () => {
      await this.host.store.removeTrigger(id).catch((error: unknown) => {
        throw isEnoent(error) ? new ApiError("not_found", `no trigger "${id}"`) : error;
      });
      return null;
    });
    return { removed: id };
  }

  private async fire(request: ApiRequest): Promise<{ job: Job | null; duplicate?: true }> {
    const trigger = this.requireLoaded(request.id);
    const body = await request.body();
    const deliveryId = body.deliveryId;
    if (deliveryId !== undefined && (typeof deliveryId !== "string" || deliveryId.trim() === "")) {
      throw new ApiError("invalid_request", "deliveryId must be a non-empty string");
    }
    if (!trigger.enabled) throw new ApiError("conflict", `trigger "${trigger.id}" is disabled`, { id: trigger.id, reason: "disabled" });
    const payload = (body.payload ?? {}) as JsonValue;
    const fired = await this.host.fire(trigger, payload, deliveryId);
    if (fired.duplicate) {
      throw new ApiError("conflict", `delivery ${deliveryId} was already fired; not firing again`, {
        id: trigger.id,
        reason: "duplicate",
        deliveryId: deliveryId ?? null,
      });
    }
    return { job: fired.job };
  }

  private async listJobs(query: URLSearchParams): Promise<{ jobs: Job[] }> {
    const status = query.get("status");
    if (status !== null && !JOB_STATUSES.includes(status as JobStatus)) throw new ApiError("invalid_request", `status must be one of ${JOB_STATUSES.join(", ")}`);
    const limitText = query.get("limit");
    const limit = limitText === null ? DEFAULT_JOB_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_LIMIT) throw new ApiError("invalid_request", `limit must be an integer from 1 to ${MAX_JOB_LIMIT}`);
    const triggerId = query.get("trigger");
    const jobs = await this.host.store.listJobs({
      ...(status ? { status: status as JobStatus } : {}),
      ...(triggerId ? { triggerId } : {}),
      last: limit,
    });
    return { jobs };
  }

  private async getJob(id: string): Promise<{ job: Job }> {
    const job = await this.host.store.getJob(id).catch((error: unknown) => {
      throw ambiguousOr(error);
    });
    if (!job) throw new ApiError("not_found", `no job "${id}"`);
    return { job };
  }

  private async cancelJob(id: string): Promise<{ job: Job }> {
    const job = await this.host.store.cancelJob(id, { reason: "cancelled via API" }).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("No job found")) throw new ApiError("not_found", `no job "${id}"`);
      throw ambiguousOr(error);
    });
    return { job };
  }

  private requireLoaded(id: string): Trigger {
    const trigger = this.host.trigger(requireId(id));
    if (!trigger) throw new ApiError("not_found", `no trigger "${id}"`);
    return trigger;
  }

  private webhookRoute(trigger: Trigger): WebhookRoute | undefined {
    if (trigger.source.kind !== "webhook") return undefined;
    const path = `/hook/${trigger.source.webhook.path.replace(/^\/+/, "")}`;
    const config = this.host.config();
    const address = this.host.webhookAddress();
    const host = localHost(config.webhook.bind);
    const localUrl = `http://${host}:${address?.port ?? config.webhook.port}${encodePath(path)}`;
    const url = config.webhook.publicUrl ? `${config.webhook.publicUrl.replace(/\/+$/, "")}${encodePath(path)}` : localUrl;
    return { path, url, localUrl };
  }
}

function pollCheckView(check: PollCheck): PollFirstCheck {
  if (check.baselined) return { baseline: { items: check.itemCount } };
  return { checked: { items: check.itemCount, new: check.newCount } };
}

function parseTriggerBody(body: Record<string, unknown>, id: string): Trigger {
  const hasToml = typeof body.toml === "string";
  const hasTrigger = body.trigger !== undefined;
  if (hasToml === hasTrigger) throw new ApiError("invalid_trigger", 'body must have exactly one of "toml" (string) or "trigger" (object)');
  let trigger: Trigger;
  try {
    if (hasToml) {
      trigger = parseTriggerToml(body.toml as string, id);
    } else {
      if (!body.trigger || typeof body.trigger !== "object" || Array.isArray(body.trigger)) throw new Error('"trigger" must be an object');
      trigger = parseTriggerRecord(body.trigger as Record<string, unknown>, id);
    }
  } catch (error) {
    throw new ApiError("invalid_trigger", `invalid trigger: ${errorMessage(error)}`, { id, error: errorMessage(error) });
  }
  if (trigger.id !== id) throw new ApiError("invalid_trigger", `body id "${trigger.id}" does not match path id "${id}"`, { id, bodyId: trigger.id });
  return trigger;
}

function requireId(id: string): string {
  if (!isValidStoreId(id)) throw new ApiError("invalid_trigger", `invalid trigger id "${id}"; use only letters, numbers, ".", "_", and "-"`, { id });
  return id;
}

function parseBooleanParam(name: string, value: string): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false" || value === "") return false;
  throw new ApiError("invalid_request", `${name} must be 1, 0, true or false`);
}

function notFoundOr(error: unknown, id: string): unknown {
  if (error instanceof Error && error.message.startsWith("No trigger found")) return new ApiError("not_found", `no trigger "${id}"`);
  return error;
}

function ambiguousOr(error: unknown): unknown {
  if (error instanceof Error && error.message.includes("is ambiguous")) return new ApiError("conflict", error.message);
  return error;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("internal", errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ApiError("invalid_request", `bad path segment "${part}"`);
  }
}

function localHost(bind: string): string {
  if (bind === "0.0.0.0" || bind === "") return "127.0.0.1";
  if (bind === "::") return "[::1]";
  return bind.includes(":") ? `[${bind}]` : bind;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError("invalid_request", `request body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError("invalid_request", `request body is not JSON: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("invalid_request", "request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
