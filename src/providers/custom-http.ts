import { existsSync, readFileSync, statSync } from "node:fs";
import { userConfigFilePath } from "../lib/user-config.js";
import {
  providerFetch,
  readBoundedResponseBody,
  type ProviderFetchNetworkOptions,
} from "../lib/http.js";
import { clampPercent } from "../lib/time.js";
import type {
  AuthProviderReport,
  CustomProviderId,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

const CONFIG_KEY = "customHttpProviders";
const SOURCE = "custom-http";
const DEADLINE_MS = 15_000;
const MAX_CONFIG_BYTES = 128 * 1024;
const CUSTOM_ID = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/;
const CONFIG_ID = /^[a-z0-9][a-z0-9:_-]{0,95}$/;
const CURRENCY = /^[A-Z]{3,12}$/;
const SYNTHETIC_ZERO_RECORD = Symbol("customHttpSyntheticZeroRecord");

export type CustomHttpProviderConfig = {
  id: CustomProviderId;
  label: string;
  usageUrl: string;
  limitsUrl?: string;
  recordsPath: string;
  ownerSelector: CustomHttpSelectorConfig;
  missingRecord?: "error" | "zero";
  reset: CustomHttpResetConfig;
  windows: CustomHttpWindowConfig[];
};

export type CustomHttpSelectorConfig = {
  field: string;
  value?: string;
  valueEnv?: string;
};

export type CustomHttpResetConfig = {
  lastResetField?: string;
  durationDaysField?: string;
  durationDays?: number;
};

export type CustomHttpWindowConfig = {
  id: string;
  label: string;
  scopes: string[];
  kind?: QuotaWindow["kind"];
  recordPath?: string;
  selector?: CustomHttpSelectorConfig;
  spendField: string;
  limitField?: string;
  limitSource?: "usage" | "limits";
  limitValue?: number;
  currency?: string;
  currencyField?: string;
};

type Dependencies = {
  fetch: typeof providerFetch;
  now: () => number;
  deadlineMs: number;
  network: ProviderFetchNetworkOptions;
  environment: Record<string, string | undefined>;
};

type Payloads = {
  usage: unknown;
  limits?: unknown;
};

type SelectedRecord = Record<string, unknown> & {
  [SYNTHETIC_ZERO_RECORD]?: true;
};

class CustomHttpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function readCustomHttpProviderConfigs(
  file = userConfigFilePath(),
): CustomHttpProviderConfig[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) {
      throw new Error("config_too_large");
    }
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && error.message === "config_too_large"
        ? "config_too_large"
        : "config_unreadable";
    throw new Error(`invalid ${CONFIG_KEY} config: ${file} ${code}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid ${CONFIG_KEY} config: ${file} invalid_json`, {
      cause: error,
    });
  }
  const root = objectValue(parsed);
  if (!root) {
    throw new Error(`invalid ${CONFIG_KEY} config: ${file} root_not_object`);
  }
  const value = root[CONFIG_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${CONFIG_KEY} config: ${CONFIG_KEY}_not_array`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const config = normalizeProviderConfig(entry, `${CONFIG_KEY}[${index}]`);
    if (ids.has(config.id)) {
      throw new Error(
        `invalid ${CONFIG_KEY} config: duplicate id ${config.id}`,
      );
    }
    ids.add(config.id);
    return config;
  });
}

export function createCustomHttpAdapter(
  config: CustomHttpProviderConfig,
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    fetch: providerFetch,
    now: () => Date.now(),
    deadlineMs: DEADLINE_MS,
    network: {},
    environment: process.env,
    ...overrides,
  };
  return {
    id: config.id,
    label: config.label,
    fetchQuota: () => fetchQuota(config, dependencies),
    inspectAuth: () => inspectAuth(config, dependencies),
  };
}

async function fetchQuota(
  config: CustomHttpProviderConfig,
  dependencies: Dependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  try {
    selectorValue(config.ownerSelector, dependencies.environment);
    const payloads = await fetchPayloads(config, dependencies);
    const normalized = normalizeCustomHttpPayload(
      config,
      payloads,
      dependencies.now(),
      dependencies.environment,
    );
    attempts.push({ source: SOURCE, status: "success" });
    return successProvider({
      provider: config.id,
      label: config.label,
      source: "api",
      windows: normalized.windows,
      customScopeBindings: normalized.scopeBindings,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const code = errorCode(error);
    attempts.push({ source: SOURCE, status: "failed", error: code });
    return failedProvider({
      provider: config.id,
      label: config.label,
      status: "error",
      error: code,
      source: "unavailable",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuth(
  config: CustomHttpProviderConfig,
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  try {
    selectorValue(config.ownerSelector, dependencies.environment);
    return {
      provider: config.id,
      sources: [{ source: SOURCE, status: "available" }],
    };
  } catch (error) {
    return {
      provider: config.id,
      sources: [{ source: SOURCE, status: "missing", error: errorCode(error) }],
    };
  }
}

async function fetchPayloads(
  config: CustomHttpProviderConfig,
  dependencies: Dependencies,
): Promise<Payloads> {
  const usage = await fetchJson(
    config.usageUrl,
    dependencies.fetch,
    dependencies.deadlineMs,
    dependencies.network,
  );
  const limits = config.limitsUrl
    ? await fetchJson(
        config.limitsUrl,
        dependencies.fetch,
        dependencies.deadlineMs,
        dependencies.network,
      )
    : undefined;
  return { usage, limits };
}

async function fetchJson(
  url: string,
  fetcher: typeof providerFetch,
  deadlineMs: number,
  network: ProviderFetchNetworkOptions,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetcher(
      url,
      { method: "GET", signal: controller.signal },
      network,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CustomHttpError("provider_request_rejected");
    }
    const bytes = await readBoundedResponseBody(
      response,
      controller.signal,
      (code) => new CustomHttpError(code),
    );
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new CustomHttpError("invalid_json");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new CustomHttpError("provider_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeCustomHttpPayload(
  config: CustomHttpProviderConfig,
  payloads: Payloads,
  nowMs: number,
  environment: Record<string, string | undefined> = process.env,
): {
  windows: QuotaWindow[];
  scopeBindings: Record<string, string[]>;
} {
  const owner = selectOwnerRecord(config, payloads.usage, environment);
  const { startsAt, resetsAt, windowSeconds } = resetWindow(
    config,
    owner,
    payloads.limits,
    nowMs,
  );
  const windows = config.windows.map((windowConfig) =>
    normalizeWindow(
      config,
      windowConfig,
      owner,
      payloads.limits,
      { startsAt, resetsAt, windowSeconds },
      environment,
    ),
  );
  const scopeBindings: Record<string, string[]> = {};
  for (const windowConfig of config.windows) {
    for (const scope of windowConfig.scopes) {
      scopeBindings[scope] = [...(scopeBindings[scope] ?? []), windowConfig.id];
    }
  }
  return { windows, scopeBindings };
}

function selectOwnerRecord(
  config: CustomHttpProviderConfig,
  usage: unknown,
  environment: Record<string, string | undefined>,
): SelectedRecord {
  const records = getPath(usage, config.recordsPath);
  if (!Array.isArray(records)) throw new CustomHttpError("records_not_array");
  const expected = selectorValue(config.ownerSelector, environment);
  const record = records.find((candidate) => {
    const object = objectValue(candidate);
    return (
      object &&
      selectorMatches(getPath(object, config.ownerSelector.field), expected)
    );
  });
  if (record) return record as SelectedRecord;
  if (config.missingRecord === "zero") {
    return { [SYNTHETIC_ZERO_RECORD]: true };
  }
  throw new CustomHttpError("owner_record_not_found");
}

function normalizeWindow(
  provider: CustomHttpProviderConfig,
  config: CustomHttpWindowConfig,
  owner: SelectedRecord,
  limits: unknown,
  reset: { startsAt: string; resetsAt: string; windowSeconds: number },
  environment: Record<string, string | undefined>,
): QuotaWindow {
  const record = selectWindowRecord(config, owner, environment);
  const spend =
    record[SYNTHETIC_ZERO_RECORD] === true
      ? 0
      : numberAt(record, config.spendField, "invalid_spend");
  const limit = limitValue(config, record, limits);
  if (limit <= 0) throw new CustomHttpError("invalid_limit");
  const currency = currencyValue(config, record, limits);
  const percentUsed = clampPercent((spend / limit) * 100);
  return {
    id: config.id,
    label: config.label,
    kind: config.kind ?? "credits",
    percentUsed,
    percentRemaining: clampPercent(100 - percentUsed),
    startsAt: reset.startsAt,
    resetsAt: reset.resetsAt,
    windowSeconds: reset.windowSeconds,
    spent: spend,
    limit,
    currency,
  };
}

function selectWindowRecord(
  config: CustomHttpWindowConfig,
  owner: SelectedRecord,
  environment: Record<string, string | undefined>,
): SelectedRecord {
  if (!config.recordPath) return owner;
  if (owner[SYNTHETIC_ZERO_RECORD] === true) return owner;
  const nested = getPath(owner, config.recordPath);
  if (!Array.isArray(nested))
    throw new CustomHttpError("window_records_not_array");
  if (!config.selector) throw new CustomHttpError("window_selector_required");
  const expected = selectorValue(config.selector, environment);
  const found = nested.find((candidate) => {
    const object = objectValue(candidate);
    return (
      object &&
      selectorMatches(getPath(object, config.selector?.field ?? ""), expected)
    );
  });
  if (!found) throw new CustomHttpError("window_record_not_found");
  return found as SelectedRecord;
}

function selectorMatches(value: unknown, expected: string): boolean {
  return (
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean") &&
    String(value) === expected
  );
}

function limitValue(
  config: CustomHttpWindowConfig,
  usageRecord: Record<string, unknown>,
  limits: unknown,
): number {
  if (config.limitValue !== undefined) return config.limitValue;
  if (!config.limitField) throw new CustomHttpError("limit_not_configured");
  const source =
    config.limitSource ?? (limits === undefined ? "usage" : "limits");
  const record = source === "usage" ? usageRecord : objectValue(limits);
  if (!record) throw new CustomHttpError("limits_not_object");
  return numberAt(record, config.limitField, "invalid_limit");
}

function currencyValue(
  config: CustomHttpWindowConfig,
  usageRecord: Record<string, unknown>,
  limits: unknown,
): string {
  if (config.currency) return config.currency;
  const source =
    config.limitSource ?? (limits === undefined ? "usage" : "limits");
  const record = source === "usage" ? usageRecord : objectValue(limits);
  const value =
    record && config.currencyField
      ? getPath(record, config.currencyField)
      : undefined;
  if (typeof value !== "string" || !CURRENCY.test(value)) {
    throw new CustomHttpError("invalid_currency");
  }
  return value;
}

function resetWindow(
  config: CustomHttpProviderConfig,
  owner: Record<string, unknown>,
  limits: unknown,
  nowMs: number,
): { startsAt: string; resetsAt: string; windowSeconds: number } {
  const durationDays =
    config.reset.durationDays ??
    (config.reset.durationDaysField
      ? numberAt(
          objectValue(limits) ?? owner,
          config.reset.durationDaysField,
          "invalid_reset_duration",
        )
      : 1);
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new CustomHttpError("invalid_reset_duration");
  }
  const windowSeconds = durationDays * 86_400;
  const fieldValue = config.reset.lastResetField
    ? getPath(owner, config.reset.lastResetField)
    : undefined;
  if (durationDays > 1 && fieldValue === undefined) {
    throw new CustomHttpError("reset_anchor_required");
  }
  const startMs =
    fieldValue === undefined
      ? dailyStartMs(nowMs)
      : parseResetField(fieldValue);
  const resetMs = startMs + windowSeconds * 1000;
  return {
    startsAt: new Date(startMs).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    windowSeconds,
  };
}

function dailyStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function parseResetField(value: unknown): number {
  const millis =
    typeof value === "number"
      ? value > 10_000_000_000
        ? value
        : value * 1000
      : typeof value === "string" && value.trim() !== ""
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(millis)) throw new CustomHttpError("invalid_reset_time");
  return millis;
}

function selectorValue(
  selector: CustomHttpSelectorConfig,
  environment: Record<string, string | undefined>,
): string {
  const value =
    selector.value !== undefined
      ? selector.value
      : selector.valueEnv
        ? environment[selector.valueEnv]
        : undefined;
  if (value === undefined || value.trim() === "") {
    throw new CustomHttpError("selector_value_missing");
  }
  return value;
}

function numberAt(
  record: Record<string, unknown>,
  path: string,
  code: string,
): number {
  const value = getPath(record, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CustomHttpError(code);
  }
  return value;
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!segment) return undefined;
    const record = objectValue(current);
    if (!record || !Object.hasOwn(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function normalizeProviderConfig(
  raw: unknown,
  path: string,
): CustomHttpProviderConfig {
  assertKnownKeys(raw, path, [
    "id",
    "label",
    "usageUrl",
    "limitsUrl",
    "recordsPath",
    "ownerSelector",
    "missingRecord",
    "reset",
    "windows",
  ]);
  const data = objectValue(raw);
  if (!data) throw configError(path, "not_object");
  const id = requiredString(data.id, `${path}.id`);
  if (!CUSTOM_ID.test(id)) throw configError(`${path}.id`, "invalid_custom_id");
  const label = requiredString(data.label, `${path}.label`);
  const usageUrl = requiredUrl(data.usageUrl, `${path}.usageUrl`);
  const limitsUrl =
    data.limitsUrl === undefined
      ? undefined
      : requiredUrl(data.limitsUrl, `${path}.limitsUrl`);
  const recordsPath = requiredPath(data.recordsPath, `${path}.recordsPath`);
  const ownerSelector = normalizeSelector(
    data.ownerSelector,
    `${path}.ownerSelector`,
  );
  const missingRecord = optionalLiteral(
    data.missingRecord,
    ["error", "zero"] as const,
    `${path}.missingRecord`,
  );
  const reset = normalizeReset(data.reset, `${path}.reset`);
  if (!Array.isArray(data.windows) || data.windows.length === 0) {
    throw configError(`${path}.windows`, "empty_or_not_array");
  }
  const windowIds = new Set<string>();
  const windows = data.windows.map((window, index) => {
    const normalized = normalizeWindowConfig(
      window,
      `${path}.windows[${index}]`,
    );
    if (windowIds.has(normalized.id)) {
      throw configError(`${path}.windows[${index}].id`, "duplicate_window_id");
    }
    windowIds.add(normalized.id);
    return normalized;
  });
  if (missingRecord === "zero") {
    if (reset.durationDaysField && limitsUrl === undefined) {
      throw configError(
        `${path}.reset.durationDaysField`,
        "unsupported_with_missing_record_zero",
      );
    }
    for (const [index, window] of windows.entries()) {
      const limitSource =
        window.limitSource ?? (limitsUrl === undefined ? "usage" : "limits");
      if (window.recordPath) {
        throw configError(
          `${path}.windows[${index}].recordPath`,
          "unsupported_with_missing_record_zero",
        );
      }
      if (window.limitValue === undefined && limitSource === "usage") {
        throw configError(
          `${path}.windows[${index}].limitSource`,
          "unsupported_with_missing_record_zero",
        );
      }
      if (window.currencyField && limitSource !== "limits") {
        throw configError(
          `${path}.windows[${index}].currencyField`,
          "usage_currency_unsupported_with_missing_record_zero",
        );
      }
    }
  }
  return {
    id: id as CustomProviderId,
    label,
    usageUrl,
    ...(limitsUrl ? { limitsUrl } : {}),
    recordsPath,
    ownerSelector,
    ...(missingRecord ? { missingRecord } : {}),
    reset,
    windows,
  };
}

function normalizeWindowConfig(
  raw: unknown,
  path: string,
): CustomHttpWindowConfig {
  assertKnownKeys(raw, path, [
    "id",
    "label",
    "scopes",
    "kind",
    "recordPath",
    "selector",
    "spendField",
    "limitField",
    "limitSource",
    "limitValue",
    "currency",
    "currencyField",
  ]);
  const data = objectValue(raw);
  if (!data) throw configError(path, "not_object");
  const id = requiredConfigId(data.id, `${path}.id`);
  const label = requiredString(data.label, `${path}.label`);
  const scopes = stringArray(data.scopes, `${path}.scopes`).map(
    (scope, index) => validateConfigId(scope, `${path}.scopes[${index}]`),
  );
  const spendField = requiredPath(data.spendField, `${path}.spendField`);
  const kind = optionalLiteral(
    data.kind,
    ["session", "weekly", "monthly", "model", "credits", "unknown"] as const,
    `${path}.kind`,
  );
  const recordPath =
    data.recordPath === undefined
      ? undefined
      : requiredPath(data.recordPath, `${path}.recordPath`);
  const selector =
    data.selector === undefined
      ? undefined
      : normalizeSelector(data.selector, `${path}.selector`);
  const limitField =
    data.limitField === undefined
      ? undefined
      : requiredPath(data.limitField, `${path}.limitField`);
  const limitValue =
    data.limitValue === undefined
      ? undefined
      : positiveNumber(data.limitValue, `${path}.limitValue`);
  if ((limitField === undefined) === (limitValue === undefined)) {
    throw configError(path, "exactly_one_limit_field_or_value_required");
  }
  const limitSource = optionalLiteral(
    data.limitSource,
    ["usage", "limits"] as const,
    `${path}.limitSource`,
  );
  const currency =
    data.currency === undefined
      ? undefined
      : requiredCurrency(data.currency, `${path}.currency`);
  const currencyField =
    data.currencyField === undefined
      ? undefined
      : requiredPath(data.currencyField, `${path}.currencyField`);
  if ((currency === undefined) === (currencyField === undefined)) {
    throw configError(path, "currency_or_currency_field_required");
  }
  return {
    id,
    label,
    scopes,
    ...(kind ? { kind } : {}),
    ...(recordPath ? { recordPath } : {}),
    ...(selector ? { selector } : {}),
    spendField,
    ...(limitField ? { limitField } : {}),
    ...(limitSource ? { limitSource } : {}),
    ...(limitValue !== undefined ? { limitValue } : {}),
    ...(currency ? { currency } : {}),
    ...(currencyField ? { currencyField } : {}),
  };
}

function normalizeSelector(
  raw: unknown,
  path: string,
): CustomHttpSelectorConfig {
  assertKnownKeys(raw, path, ["field", "value", "valueEnv"]);
  const data = objectValue(raw);
  if (!data) throw configError(path, "not_object");
  const field = requiredPath(data.field, `${path}.field`);
  const value =
    data.value === undefined
      ? undefined
      : requiredString(data.value, `${path}.value`);
  const valueEnv =
    data.valueEnv === undefined
      ? undefined
      : requiredEnvName(data.valueEnv, `${path}.valueEnv`);
  if ((value === undefined) === (valueEnv === undefined)) {
    throw configError(path, "exactly_one_value_or_value_env_required");
  }
  return {
    field,
    ...(value ? { value } : {}),
    ...(valueEnv ? { valueEnv } : {}),
  };
}

function normalizeReset(raw: unknown, path: string): CustomHttpResetConfig {
  assertKnownKeys(raw, path, [
    "lastResetField",
    "durationDaysField",
    "durationDays",
  ]);
  const data = objectValue(raw);
  if (!data) throw configError(path, "not_object");
  const lastResetField =
    data.lastResetField === undefined
      ? undefined
      : requiredPath(data.lastResetField, `${path}.lastResetField`);
  const durationDaysField =
    data.durationDaysField === undefined
      ? undefined
      : requiredPath(data.durationDaysField, `${path}.durationDaysField`);
  const durationDays =
    data.durationDays === undefined
      ? undefined
      : positiveInteger(data.durationDays, `${path}.durationDays`);
  if (durationDays !== undefined && durationDaysField !== undefined) {
    throw configError(path, "duration_days_or_field_required");
  }
  if (durationDays !== undefined && durationDays > 1 && !lastResetField) {
    throw configError(path, "duration_requires_last_reset_field");
  }
  return {
    ...(lastResetField ? { lastResetField } : {}),
    ...(durationDaysField ? { durationDaysField } : {}),
    ...(durationDays !== undefined ? { durationDays } : {}),
  };
}

function assertKnownKeys(
  raw: unknown,
  path: string,
  keys: readonly string[],
): void {
  const data = objectValue(raw);
  if (!data) return;
  const allowed = new Set(keys);
  const unknown = Object.keys(data).find((key) => !allowed.has(key));
  if (unknown) throw configError(`${path}.${unknown}`, "unknown_key");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(path, "required_string");
  }
  return value;
}

function requiredPath(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (result.split(".").some((segment) => segment.trim() === "")) {
    throw configError(path, "invalid_path");
  }
  return result;
}

function requiredUrl(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported_protocol");
    }
    return url.href;
  } catch {
    throw configError(path, "invalid_url");
  }
}

function requiredEnvName(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(raw)) {
    throw configError(path, "invalid_env_name");
  }
  return raw;
}

function requiredCurrency(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  if (!CURRENCY.test(raw)) throw configError(path, "invalid_currency");
  return raw;
}

function requiredConfigId(value: unknown, path: string): string {
  return validateConfigId(requiredString(value, path), path);
}

function validateConfigId(value: string, path: string): string {
  if (!CONFIG_ID.test(value)) throw configError(path, "invalid_id");
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw configError(path, "required_string_array");
  }
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw configError(path, "required_positive_number");
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = positiveNumber(value, path);
  if (!Number.isInteger(number)) throw configError(path, "required_integer");
  return number;
}

function optionalLiteral<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && values.includes(value)) {
    return value;
  }
  throw configError(path, "unsupported_value");
}

function configError(path: string, code: string): Error {
  return new Error(`invalid ${CONFIG_KEY} config: ${path} ${code}`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof CustomHttpError) return error.code;
  if (
    error instanceof Error &&
    error.message.startsWith(`invalid ${CONFIG_KEY}`)
  )
    return error.message;
  return "provider_read_failed";
}
