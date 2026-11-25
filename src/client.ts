import http from "node:http";
import type { Socket } from "node:net";
import type {
  ApiErrorCode,
  DeleteTriggerResponse,
  FireRequest,
  FireResponse,
  JobResponse,
  PutTriggerResponse,
  TriggerResponse,
} from "./api-types.js";
import type { JsonValue } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_ANSWER_TIMEOUT_MS = 5 * 60_000;
const UNREACHABLE_ERRNOS = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);
const FALLBACK_CODES = new Set<ClientErrorCode>(["unreachable", "stopping", "unsupported"]);

export type ClientErrorCode = ApiErrorCode | "unreachable" | "interrupted" | "bad_answer";

export class ApiClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: JsonValue,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get daemonDidNotAct(): boolean {
    return FALLBACK_CODES.has(this.code);
  }
}

export type ClientOptions = { connectTimeoutMs?: number; answerTimeoutMs?: number };

export class PollinateClient {
  private readonly connectTimeoutMs: number;
  private readonly answerTimeoutMs: number;

  constructor(
    readonly socketPath: string,
    options: ClientOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  }

  putTrigger(id: string, toml: string): Promise<PutTriggerResponse> {
    return this.call("PUT", `/v1/triggers/${encodeURIComponent(id)}`, { toml });
  }

  setTriggerEnabled(id: string, enabled: boolean): Promise<TriggerResponse> {
    return this.call("PATCH", `/v1/triggers/${encodeURIComponent(id)}`, { enabled });
  }

  removeTrigger(id: string): Promise<DeleteTriggerResponse> {
    return this.call("DELETE", `/v1/triggers/${encodeURIComponent(id)}`);
  }

  fireTrigger(id: string, request: FireRequest = {}): Promise<FireResponse> {
    return this.call("POST", `/v1/triggers/${encodeURIComponent(id)}/fire`, request);
  }

  cancelJob(id: string): Promise<JobResponse> {
    return this.call("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      let connected = false;
      let settled = false;
      const finish = (error: ApiClientError | undefined, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(answerTimer);
        if (error) {
          request.destroy();
          reject(error);
        } else resolve(value as T);
      };
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path,
        agent: false,
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      });
      const connectTimer = setTimeout(
        () => finish(new ApiClientError("unreachable", `the daemon did not accept a connection on ${this.socketPath} within ${this.connectTimeoutMs} ms`)),
        this.connectTimeoutMs,
      );
      let answerTimer: NodeJS.Timeout | undefined;
      request.on("socket", (socket: Socket) => {
        const onConnect = () => {
          connected = true;
          clearTimeout(connectTimer);
          answerTimer = setTimeout(
            () => finish(interrupted(`the daemon did not answer ${method} ${path} within ${Math.round(this.answerTimeoutMs / 1000)} s`)),
            this.answerTimeoutMs,
          );
        };
        if (socket.connecting) socket.once("connect", onConnect);
        else onConnect();
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (!connected && error.code && UNREACHABLE_ERRNOS.has(error.code)) {
          finish(new ApiClientError("unreachable", `no daemon answers on ${this.socketPath} (${error.code})`));
          return;
        }
        if (!connected) {
          finish(new ApiClientError("internal", `could not reach the daemon on ${this.socketPath}: ${error.message}`));
          return;
        }
        finish(interrupted(`the daemon connection failed during ${method} ${path}: ${error.message}`));
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (error) => finish(interrupted(`the daemon answer to ${method} ${path} broke off: ${error.message}`)));
        response.on("aborted", () => finish(interrupted(`the daemon closed the connection while answering ${method} ${path}`)));
        response.on("end", () => {
          if (!response.complete) {
            finish(interrupted(`the daemon closed the connection while answering ${method} ${path}`));
            return;
          }
          const status = response.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            finish(new ApiClientError("bad_answer", `the daemon answered ${method} ${path} with ${status} and a body that is not JSON`, undefined, status));
            return;
          }
          if (status >= 200 && status < 300) {
            finish(undefined, parsed as T);
            return;
          }
          finish(errorFromAnswer(parsed, status, `${method} ${path}`));
        });
      });
      request.end(payload);
    });
  }
}

function interrupted(message: string): ApiClientError {
  return new ApiClientError("interrupted", `${message}; it may have taken effect, so it was not retried. Check pol jobs / pol ledger`);
}

function errorFromAnswer(parsed: unknown, status: number, call: string): ApiClientError {
  const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: JsonValue } } | null)?.error;
  if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
    return new ApiClientError("bad_answer", `the daemon answered ${call} with ${status} and no error body`, undefined, status);
  }
  return new ApiClientError(error.code as ClientErrorCode, error.message, error.details, status);
}
