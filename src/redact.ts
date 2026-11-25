export const REDACTED = "<redacted>";

export function redactHeaderValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactHeaderValues(item)) as T;
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === "headers" ? redactHeaderMap(item) : redactHeaderValues(item)]),
  ) as T;
}

export function redactHeaderMap(headers: unknown): unknown {
  if (!isPlainObject(headers)) return headers;
  return Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
