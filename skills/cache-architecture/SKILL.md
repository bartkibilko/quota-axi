---
name: cache-architecture
description: "Cache storage locations, permissions, context scoping, isolation rules, and lifecycle management in quota-axi."
user-invocable: false
---

# Quota Cache Architecture & Context Scoping

This document details the disk caching architecture, file permissions, context-scoping mechanism, and data retention policies implemented in `src/cache.ts`.

---

## Cache Storage & Security

- **Path**: `~/.cache/quota-axi/quotas.json`, or `$XDG_CACHE_HOME/quota-axi/quotas.json` if `XDG_CACHE_HOME` is set.
- **File Permissions**: Cache files and parent directories must be created with strict `0600` (read/write by owner only) and `0700` permissions.
- **Normalized Data Only**: Cache records contain only normalized, non-secret quota snapshot structures.
- **Strict Prohibition**: Never persist raw HTTP responses, headers, authorization bearers, refresh tokens, API keys, or browser cookies.

---

## Context-Scoped Providers (`CONTEXT_SCOPED_PROVIDERS`)

Use `CONTEXT_SCOPED_PROVIDERS` in `src/cache.ts` for the enrolled providers and their identity functions. Before changing context stamps, stale fallback, or cache write/clear eligibility, follow [README Cache](../../README.md#cache), including the Claude profile, Copilot host, Kimi source, and Codex ownership rules.

---

## Cache Lifecycle & Exclusions

The following fields and statuses are **never cached**:

- **Non-fresh or empty reads**: Only readings with `state.status: "fresh"`, at least one window, and a source other than `cache` are written (`toCacheProvider`); every other status and every cache-served report is skipped. `failed` is an attempt status, not a provider `state.status`.
- **Stale reads**: Stale data is never re-persisted as fresh.
- **Account identities**: Explicit `account` objects are scrubbed before writing.
- **Source attempts**: The report's `attempts` list and attempt diagnostic logs are excluded.
- **Derived pace & runway**: `pace`, `runway`, and selection signals are dynamic derivations computed from `generatedAt` vs current time. They must never be frozen into cache.

PHI-safe job counts (`jobs.sampled` / `completed` / `failed` / `other`) are stored with the snapshot the same way `credits` is. A snapshot that never carried jobs stays without them; prompts, URLs, ids, and account identity never enter the cache. Higgsfield is excluded from `--max-age` fresh reuse (`excludeFromFreshReuse`), matching Muse: a CLI login switch is not a traced file, and the status payload has no stable non-email account discriminator.

---

## Keychain Access Markers

- Stored alongside the cache directory in `~/.cache/quota-axi/`.
- Must have `0600` permissions.
- Filename is keyed by a hash of the selected service and account name. Contains no secret material.
- Permits non-prompting subsequent Keychain value reads once an initial grant is confirmed.
