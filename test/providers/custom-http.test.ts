import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaCommand } from "../../src/commands.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { userConfigFilePath } from "../../src/lib/user-config.js";
import {
  createCustomHttpAdapter,
  normalizeCustomHttpPayload,
  readCustomHttpProviderConfigs,
  type CustomHttpProviderConfig,
} from "../../src/providers/custom-http.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalOwner = process.env.QUOTA_AXI_EXAMPLE_USER;
let tempDir: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  restoreEnvironment("XDG_CONFIG_HOME", originalConfigHome);
  restoreEnvironment("QUOTA_AXI_EXAMPLE_USER", originalOwner);
  process.exitCode = undefined;
});

describe("custom HTTP provider", () => {
  it("validates local config and rejects unknown provider keys", () => {
    const file = writeConfig({
      customHttpProviders: [
        {
          ...exampleConfig(),
          privateHostnameHint: "should-not-be-accepted",
        },
      ],
    });

    expect(() => readCustomHttpProviderConfigs(file)).toThrow(
      "customHttpProviders[0].privateHostnameHint unknown_key",
    );
  });

  it("rejects reset keys that would imply unsupported local-time semantics", () => {
    const file = writeConfig({
      customHttpProviders: [
        {
          ...exampleConfig(),
          reset: {
            ...exampleConfig().reset,
            timezone: "UTC",
          },
        },
      ],
    });

    expect(() => readCustomHttpProviderConfigs(file)).toThrow(
      "customHttpProviders[0].reset.timezone unknown_key",
    );
  });

  it("rejects multi-day windows without an explicit reset anchor", () => {
    const file = writeConfig({
      customHttpProviders: [
        {
          ...exampleConfig(),
          reset: {
            durationDays: 7,
          },
        },
      ],
    });

    expect(() => readCustomHttpProviderConfigs(file)).toThrow(
      "customHttpProviders[0].reset duration_requires_last_reset_field",
    );
  });

  it("rejects duration fields that resolve to multi-day without a reset anchor", () => {
    expect(() =>
      normalizeCustomHttpPayload(
        {
          ...exampleConfig(),
          reset: { durationDaysField: "spendingWindowDays" },
        },
        {
          usage: {
            users: [{ email: "owner@example.com", daily_spend_eur: 5 }],
          },
          limits: {
            spendingWindowDays: 7,
            highClassSpendingCutoffEur: 10,
            fullSpendingCutoffEur: 20,
          },
        },
        Date.parse("2026-09-24T12:00:00Z"),
        { QUOTA_AXI_EXAMPLE_USER: "owner@example.com" },
      ),
    ).toThrow("reset_anchor_required");
  });

  it("rejects multi-day windows whose configured reset anchor is absent from the record", () => {
    expect(() =>
      normalizeCustomHttpPayload(
        {
          ...exampleConfig(),
          reset: { lastResetField: "budget_reset_at", durationDays: 7 },
        },
        {
          usage: {
            users: [{ email: "owner@example.com", daily_spend_eur: 5 }],
          },
          limits: {
            highClassSpendingCutoffEur: 10,
            fullSpendingCutoffEur: 20,
          },
        },
        Date.parse("2026-09-24T12:00:00Z"),
        { QUOTA_AXI_EXAMPLE_USER: "owner@example.com" },
      ),
    ).toThrow("reset_anchor_required");
  });

  it("rejects zero-missing owner records when a window needs a nested record", () => {
    const file = writeConfig({
      customHttpProviders: [
        {
          ...exampleConfig(),
          missingRecord: "zero",
          windows: [
            {
              ...exampleConfig().windows[0],
              recordPath: "windows",
              selector: { field: "class", value: "total" },
            },
          ],
        },
      ],
    });

    expect(() => readCustomHttpProviderConfigs(file)).toThrow(
      "customHttpProviders[0].windows[0].recordPath unsupported_with_missing_record_zero",
    );
  });

  it("normalizes only the selected owner's spend windows", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://example.com/usage/daily") {
        return jsonResponse({
          users: [
            {
              email: "other@example.com",
              daily_spend_eur: 99,
              daily_last_reset_time: 1_790_208_000_000,
            },
            {
              email: "owner@example.com",
              daily_spend_eur: 2.5,
              daily_last_reset_time: 1_790_208_000_000,
            },
          ],
        });
      }
      if (url === "https://example.com/limits/current") {
        return jsonResponse({
          spendingWindowDays: 1,
          highClassSpendingCutoffEur: 10,
          fullSpendingCutoffEur: 20,
        });
      }
      return new Response("", { status: 404 });
    });

    const report = await createCustomHttpAdapter(exampleConfig(), {
      fetch: request,
      now: () => Date.parse("2026-09-24T12:00:00Z"),
      environment: { QUOTA_AXI_EXAMPLE_USER: "owner@example.com" },
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "custom:example",
      label: "Example HTTP Spend",
      source: "api",
      customScopeBindings: {
        all_models: ["daily_total"],
        high_class_models: ["daily_total", "daily_high_class"],
      },
      windows: [
        {
          id: "daily_total",
          percentUsed: 13,
          percentRemaining: 87,
          spent: 2.5,
          limit: 20,
          currency: "EUR",
          startsAt: "2026-09-24T00:00:00.000Z",
          resetsAt: "2026-09-25T00:00:00.000Z",
        },
        {
          id: "daily_high_class",
          percentUsed: 25,
          percentRemaining: 75,
          spent: 2.5,
          limit: 10,
          currency: "EUR",
        },
      ],
      state: { status: "fresh", stale: false },
    });
    expect(JSON.stringify(report)).not.toContain("other@example.com");
  });

  it("makes configured scopes measurable through normal interpretation", () => {
    const normalized = normalizeCustomHttpPayload(
      exampleConfig(),
      {
        usage: {
          users: [
            {
              email: "owner@example.com",
              daily_spend_eur: 5,
              daily_last_reset_time: 1_790_208_000_000,
            },
          ],
        },
        limits: {
          spendingWindowDays: 1,
          highClassSpendingCutoffEur: 10,
          fullSpendingCutoffEur: 20,
        },
      },
      Date.parse("2026-09-24T12:00:00Z"),
      { QUOTA_AXI_EXAMPLE_USER: "owner@example.com" },
    );
    const interpreted = withQuotaSemantics(
      {
        provider: "custom:example",
        label: "Example HTTP Spend",
        source: "api",
        windows: normalized.windows,
        customScopeBindings: normalized.scopeBindings,
        state: { status: "fresh", stale: false },
      },
      "2026-09-24T12:00:00.000Z",
    );

    expect(interpreted.quotaSemantics?.effectiveAvailability).toMatchObject([
      {
        scope: "all_models",
        status: "known",
        effectivePercentRemaining: 75,
        selection: { status: "known" },
      },
      {
        scope: "high_class_models",
        status: "known",
        effectivePercentRemaining: 50,
        boundedBy: ["daily_total", "daily_high_class"],
        runway: { status: "through_reset" },
      },
    ]);
  });

  it("can treat a missing selected owner record as zero spend", () => {
    const normalized = normalizeCustomHttpPayload(
      { ...exampleConfig(), missingRecord: "zero" },
      {
        usage: {
          users: [
            {
              email: "other@example.com",
              daily_spend_eur: 5,
              daily_last_reset_time: 1_790_208_000_000,
            },
          ],
        },
        limits: {
          spendingWindowDays: 1,
          highClassSpendingCutoffEur: 10,
          fullSpendingCutoffEur: 20,
        },
      },
      Date.parse("2026-09-24T12:00:00Z"),
      { QUOTA_AXI_EXAMPLE_USER: "owner@example.com" },
    );

    expect(normalized.windows).toMatchObject([
      { id: "daily_total", percentRemaining: 100, spent: 0, limit: 20 },
      {
        id: "daily_high_class",
        percentRemaining: 100,
        spent: 0,
        limit: 10,
      },
    ]);
  });

  it("loads configured providers into --provider selection and JSON output", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(
      join(tmpdir(), "quota-axi-custom-http-"),
    );
    tempDir = process.env.XDG_CONFIG_HOME;
    process.env.QUOTA_AXI_EXAMPLE_USER = "owner@example.com";
    writeConfigFile({
      customHttpProviders: [exampleConfig()],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://example.com/usage/daily") {
          return jsonResponse({
            users: [
              {
                email: "owner@example.com",
                daily_spend_eur: 1,
                daily_last_reset_time: 1_790_208_000_000,
              },
            ],
          });
        }
        return jsonResponse({
          spendingWindowDays: 1,
          highClassSpendingCutoffEur: 10,
          fullSpendingCutoffEur: 20,
        });
      }),
    );

    const output = await quotaCommand(
      ["--provider", "custom:example", "--json"],
      { binPath: "quota-axi" },
    );
    const parsed = JSON.parse(output);

    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]).toMatchObject({
      provider: "custom:example",
      windows: [
        { id: "daily_total", percentRemaining: 95 },
        { id: "daily_high_class", percentRemaining: 90 },
      ],
      quotaSemantics: {
        effectiveAvailability: [
          { scope: "all_models", effectivePercentRemaining: 95 },
          { scope: "high_class_models", effectivePercentRemaining: 90 },
        ],
      },
    });
    expect(output).not.toContain("owner@example.com");
  });

  it("reports a clear runtime error when the selector environment is absent", async () => {
    const report = await createCustomHttpAdapter(exampleConfig(), {
      fetch: vi.fn(),
      environment: {},
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "custom:example",
      state: {
        status: "error",
        error: "selector_value_missing",
      },
      attempts: [
        {
          source: "custom-http",
          status: "failed",
          error: "selector_value_missing",
        },
      ],
    });
  });

  it("surfaces malformed custom provider config as a validation error", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(
      join(tmpdir(), "quota-axi-custom-http-"),
    );
    tempDir = process.env.XDG_CONFIG_HOME;
    writeConfigFile({
      customHttpProviders: [{ ...exampleConfig(), id: "bad" }],
    });

    await expect(
      quotaCommand(["--provider", "custom:example"], { binPath: "quota-axi" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("invalid_custom_id"),
    });
  });
});

function exampleConfig(): CustomHttpProviderConfig {
  return {
    id: "custom:example",
    label: "Example HTTP Spend",
    usageUrl: "https://example.com/usage/daily",
    limitsUrl: "https://example.com/limits/current",
    recordsPath: "users",
    ownerSelector: {
      field: "email",
      valueEnv: "QUOTA_AXI_EXAMPLE_USER",
    },
    reset: {
      lastResetField: "daily_last_reset_time",
      durationDaysField: "spendingWindowDays",
    },
    windows: [
      {
        id: "daily_total",
        label: "daily total",
        scopes: ["all_models", "high_class_models"],
        spendField: "daily_spend_eur",
        limitSource: "limits",
        limitField: "fullSpendingCutoffEur",
        currency: "EUR",
      },
      {
        id: "daily_high_class",
        label: "daily high class",
        scopes: ["high_class_models"],
        spendField: "daily_spend_eur",
        limitSource: "limits",
        limitField: "highClassSpendingCutoffEur",
        currency: "EUR",
      },
    ],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function writeConfig(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-custom-http-"));
  tempDir = root;
  const file = userConfigFilePath({ XDG_CONFIG_HOME: root });
  mkdirSync(join(root, "quota-axi"));
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function writeConfigFile(value: unknown): void {
  const file = userConfigFilePath();
  mkdirSync(join(process.env.XDG_CONFIG_HOME as string, "quota-axi"));
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function restoreEnvironment(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}
