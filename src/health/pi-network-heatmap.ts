/**
 * @file pi-network-heatmap.ts
 * @description API endpoint failure heatmap for Pi Network mobile webview apps.
 *
 * Intercepts `fetch` calls (and optionally `XMLHttpRequest`) to map out which
 * backend API endpoints and Pi Horizon nodes are failing most often, broken
 * down by global region.
 *
 * The heatmap aggregates:
 *   - Total request count per endpoint
 *   - Failure count and failure rate
 *   - Latency percentiles (P50, P95, P99)
 *   - Per-region failure counts
 *
 * Data is surfaced via the TelemetryEngine's MCP tools so AI agents can
 * identify the most problematic endpoints autonomously.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type {
  EndpointFailureRecord,
  HeatmapEntry,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the network heatmap interceptor. */
export interface NetworkHeatmapConfig {
  /** TelemetryEngine to report heatmap data through. */
  readonly engine: TelemetryEngine;
  /**
   * URL path prefixes to monitor. Requests not matching any prefix are ignored.
   * Use an empty array to monitor ALL requests (can be noisy).
   * Defaults to ["/api", "https://api.minepi.com", "https://horizon.minepi.com"].
   */
  readonly watchedPrefixes?: readonly string[];
  /**
   * HTTP status codes to treat as failures.
   * Defaults to any status >= 400.
   */
  readonly failureStatusCodes?: readonly number[];
  /**
   * Minimum latency (in ms) that triggers a slow-request warning event.
   * Defaults to 3_000.
   */
  readonly slowRequestThresholdMs?: number;
  /**
   * The ISO 3166-1 alpha-2 region code of the current device.
   * If not provided, the heatmap uses "unknown".
   */
  readonly region?: string;
}

/** Handle returned by `installNetworkHeatmap`. */
export interface NetworkHeatmapHandle {
  /** Removes fetch interception and clears the heatmap. */
  remove(): void;
  /** Returns all current heatmap entries sorted by failure rate descending. */
  getHeatmap(): readonly HeatmapEntry[];
  /** Returns the raw endpoint failure records. */
  getFailureRecords(): readonly EndpointFailureRecord[];
  /** Returns true if the interceptor is currently active. */
  isActive(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a URL to an endpoint key by stripping query strings and path IDs.
 * E.g., "/api/payments/abc123" → "/api/payments/:id"
 *
 * @param url - The raw request URL.
 * @returns A normalized endpoint key.
 */
function normalizeEndpoint(url: string): string {
  try {
    // Try as a full URL first
    const parsed = new URL(url);
    const path = parsed.pathname
      // Replace UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
      // Replace numeric IDs
      .replace(/\/\d+/g, "/:id")
      // Replace hex strings (wallet addresses / tx hashes)
      .replace(/\/[0-9a-f]{20,}/gi, "/:hash");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    // Relative URL
    return url
      .split("?")[0]!
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
      .replace(/\/\d+/g, "/:id")
      .replace(/\/[0-9a-f]{20,}/gi, "/:hash");
  }
}

/**
 * Checks if a URL should be monitored based on the watched prefixes list.
 *
 * @param url - The request URL.
 * @param prefixes - The list of watched prefixes.
 * @returns True if the request should be tracked.
 */
function isWatched(url: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => url.startsWith(prefix));
}

/**
 * Computes percentile from a sorted array of numbers.
 *
 * @param sorted - Sorted array of numbers (ascending).
 * @param percentile - 0–100.
 * @returns The value at the given percentile.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

// ---------------------------------------------------------------------------
// In-Memory Aggregation Store
// ---------------------------------------------------------------------------

interface AggEntry {
  endpoint: string;
  totalRequests: number;
  failureCount: number;
  latencies: number[];
  regionCounts: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Installs the network heatmap by patching the global `fetch` function.
 *
 * All matching requests are timed; failures are counted and aggregated into
 * the per-endpoint heatmap. Data is flushed to the TelemetryEngine after
 * every request so MCP tools always see fresh data.
 *
 * @param config - Heatmap configuration.
 * @returns A handle with `remove()` and `getHeatmap()` methods.
 *
 * @example
 * ```ts
 * const heatmap = installNetworkHeatmap({ engine, region: "US" });
 * // On teardown:
 * heatmap.remove();
 * ```
 */
export function installNetworkHeatmap(
  config: NetworkHeatmapConfig
): NetworkHeatmapHandle {
  const {
    engine,
    watchedPrefixes = ["/api", "https://api.minepi.com", "https://horizon.minepi.com"],
    slowRequestThresholdMs = 3_000,
    region = "unknown",
  } = config;

  const failureStatusCodes = config.failureStatusCodes ?? null; // null = use >= 400 rule

  const aggregation = new Map<string, AggEntry>();
  const failureRecords: EndpointFailureRecord[] = [];
  let active = false;

  // Stash original fetch
  const originalFetch = globalThis.fetch.bind(globalThis);

  /**
   * Updates the heatmap aggregation for an endpoint and pushes to the engine.
   */
  function recordResult(
    endpoint: string,
    statusCode: number,
    latencyMs: number,
    method: string
  ): void {
    const isFailed =
      failureStatusCodes !== null
        ? failureStatusCodes.includes(statusCode)
        : statusCode >= 400;

    let entry = aggregation.get(endpoint);
    if (entry === undefined) {
      entry = {
        endpoint,
        totalRequests: 0,
        failureCount: 0,
        latencies: [],
        regionCounts: new Map(),
      };
      aggregation.set(endpoint, entry);
    }

    entry.totalRequests++;
    entry.latencies.push(latencyMs);
    // Cap latency history to last 200 entries for memory efficiency
    if (entry.latencies.length > 200) entry.latencies.shift();

    if (isFailed) {
      entry.failureCount++;
      const regionCount = entry.regionCounts.get(region) ?? 0;
      entry.regionCounts.set(region, regionCount + 1);

      const rec: EndpointFailureRecord = {
        endpoint,
        method: method as EndpointFailureRecord["method"],
        statusCode,
        latencyMs,
        region,
        timestamp: new Date().toISOString(),
      };
      failureRecords.push(rec);
      // Cap at 500 records
      if (failureRecords.length > 500) failureRecords.shift();
    }

    // Compute percentiles from sorted copy
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    const regionBreakdown: Record<string, number> = {};
    for (const [reg, count] of entry.regionCounts.entries()) {
      regionBreakdown[reg] = count;
    }

    const heatmapEntry: HeatmapEntry = {
      endpoint,
      totalRequests: entry.totalRequests,
      failureCount: entry.failureCount,
      failureRate: entry.failureCount / entry.totalRequests,
      p50LatencyMs: percentile(sorted, 50),
      p95LatencyMs: percentile(sorted, 95),
      p99LatencyMs: percentile(sorted, 99),
      regionBreakdown,
    };

    // Push updated entry to the engine
    engine.upsertHeatmapEntry(heatmapEntry);

    // Emit telemetry events for failures and slow requests
    if (isFailed) {
      void engine.log(
        "error",
        `[NetworkHeatmap] Request failed: ${method} ${endpoint} → ${statusCode}`,
        {
          endpoint,
          method,
          statusCode,
          latencyMs,
          region,
          failureRate: Math.round(heatmapEntry.failureRate * 100),
        },
        "network"
      );
    } else if (latencyMs > slowRequestThresholdMs) {
      void engine.log(
        "warn",
        `[NetworkHeatmap] Slow request: ${method} ${endpoint} took ${latencyMs}ms`,
        { endpoint, method, latencyMs, region },
        "network"
      );
    }
  }

  // Patch global fetch
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
        ? input.url
        : input;

    const method =
      (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (!isWatched(url, watchedPrefixes)) {
      return originalFetch(input, init);
    }

    const endpoint = normalizeEndpoint(url);
    const startTime = performance.now();

    try {
      const response = await originalFetch(input, init);
      const latencyMs = Math.round(performance.now() - startTime);
      recordResult(endpoint, response.status, latencyMs, method);
      return response;
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      // Network error = treat as 0 status (connection failure)
      recordResult(endpoint, 0, latencyMs, method);

      void engine.log(
        "error",
        `[NetworkHeatmap] Network error on ${method} ${endpoint}`,
        {
          endpoint,
          method,
          latencyMs,
          region,
          errorMessage: err instanceof Error ? err.message : "unknown",
        },
        "network"
      );

      throw err;
    }
  };

  active = true;

  return {
    remove() {
      if (!active) return;
      globalThis.fetch = originalFetch;
      active = false;
    },
    getHeatmap() {
      return Array.from(aggregation.values()).map((entry): HeatmapEntry => {
        const sorted = [...entry.latencies].sort((a, b) => a - b);
        const regionBreakdown: Record<string, number> = {};
        for (const [reg, count] of entry.regionCounts.entries()) {
          regionBreakdown[reg] = count;
        }
        return {
          endpoint: entry.endpoint,
          totalRequests: entry.totalRequests,
          failureCount: entry.failureCount,
          failureRate: entry.totalRequests > 0
            ? entry.failureCount / entry.totalRequests
            : 0,
          p50LatencyMs: percentile(sorted, 50),
          p95LatencyMs: percentile(sorted, 95),
          p99LatencyMs: percentile(sorted, 99),
          regionBreakdown,
        };
      }).sort((a, b) => b.failureRate - a.failureRate);
    },
    getFailureRecords() {
      return [...failureRecords];
    },
    isActive() {
      return active;
    },
  };
}
