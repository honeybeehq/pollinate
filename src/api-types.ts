import type { Job, JobStatus, JsonValue, Trigger } from "./types.js";

export const API_FEATURES = ["retry", "baseline", "onFailure"] as const;

export type ApiFeature = (typeof API_FEATURES)[number] | "events";

export type ApiErrorCode =
  | "invalid_trigger"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "poll_failed"
  | "stopping"
  | "unsupported"
  | "internal";

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_trigger: 400,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  poll_failed: 422,
  stopping: 503,
  unsupported: 501,
  internal: 500,
};

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string; details?: JsonValue } };

export type HealthResponse = {
  name: "pollinate";
  version: string;
  commit: string | null;
  api: number;
  features: ApiFeature[];
  pid: number;
  startedAt: string;
  reloadedAt: string;
  store: string;
  triggers: { total: number; enabled: number };
  webhook: { bind: string; port: number; publicUrl: string | null };
  hive?: { path: string; version: string | null };
};

export type PutTriggerRequest = { toml: string } | { trigger: Record<string, JsonValue> };

export type WebhookRoute = { path: string; url: string; localUrl: string };

export type PollFirstCheck = { baseline: { items: number } } | { checked: { items: number; new: number } };

export type PutTriggerResponse = {
  trigger: Trigger;
  created: boolean;
  loaded: true;
  schedule?: { nextFireAt: string | null };
  webhook?: WebhookRoute;
  poll?: PollFirstCheck;
};

export type TriggerState = {
  nextFireAt: string | null;
  lastFireAt: string | null;
  lastJob: { id: string; status: JobStatus; error: string | null } | null;
  consecutiveFailures: number;
  deliveries: number;
};

export type TriggerView = Trigger & { state: TriggerState };

export type TriggerListResponse = { triggers: TriggerView[] };

export type TriggerResponse = { trigger: TriggerView };

export type PatchTriggerRequest = { enabled: boolean };

export type DeleteTriggerResponse = { removed: string };

export type FireRequest = { payload?: JsonValue; deliveryId?: string };

export type FireResponse = { job: Job | null };

export type JobListResponse = { jobs: Job[] };

export type JobResponse = { job: Job };
