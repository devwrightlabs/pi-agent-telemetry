/**
 * @file pi-predictive-oracle.ts
 * @description Predictive memory crash oracle for the Pi Network mobile webview.
 *
 * Actively polls the JavaScript heap via `performance.memory` (Chrome/WebView)
 * and estimates device RAM pressure. When heap usage exceeds configurable
 * thresholds, it:
 *   1. Emits a WARNING telemetry event at 75% heap usage.
 *   2. Triggers an EMERGENCY state dump at 90% heap usage (or on app crash).
 *
 * The emergency dump captures the current telemetry queue, memory snapshot,
 * and user journey and attempts an immediate upload to the Devright dashboard.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type { MemorySnapshot, OracleThresholds } from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the predictive oracle. */
export interface PredictiveOracleConfig {
  /** TelemetryEngine instance to report alerts through. */
  readonly engine: TelemetryEngine;
  /** Memory usage thresholds for WARN and CRITICAL levels. */
  readonly thresholds?: Partial<OracleThresholds>;
  /**
   * How often (in milliseconds) to poll memory usage.
   * Defaults to 5_000 (5 seconds).
   */
  readonly pollIntervalMs?: number;
}

/** Handle returned by `startPredictiveOracle`. */
export interface PredictiveOracleHandle {
  /** Stops the polling loop and cleans up. */
  stop(): void;
  /** Returns the most recently captured memory snapshot. */
  getLatestSnapshot(): MemorySnapshot | null;
  /** Returns true if the oracle is currently running. */
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// performance.memory Type Augmentation
// ---------------------------------------------------------------------------

/**
 * Chrome/WebView non-standard `performance.memory` API.
 * Not available in Firefox/Safari but consistently present in Android WebView.
 */
interface PerformanceMemoryInfo {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemoryInfo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Captures a memory snapshot from the browser environment.
 * Returns null if `performance.memory` is not available (non-Chromium).
 */
function captureMemorySnapshot(): MemorySnapshot | null {
  try {
    const perf = performance as PerformanceWithMemory;
    if (!perf.memory) return null;

    const used = perf.memory.usedJSHeapSize;
    const total = perf.memory.totalJSHeapSize;
    const limit = perf.memory.jsHeapSizeLimit;
    const ratio = limit > 0 ? used / limit : 0;

    return {
      timestamp: new Date().toISOString(),
      jsHeapUsedBytes: used,
      jsHeapTotalBytes: total,
      jsHeapLimitBytes: limit,
      deviceRamUsedEstimateBytes: null, // Not accessible from JS
      heapUsageRatio: ratio,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the predictive memory oracle polling loop.
 *
 * Polls `performance.memory` at the configured interval, updating the engine's
 * memory snapshot and emitting telemetry alerts when thresholds are breached.
 *
 * @param config - Oracle configuration.
 * @returns A handle with `stop()` and `getLatestSnapshot()` methods.
 *
 * @example
 * ```ts
 * const oracle = startPredictiveOracle({ engine, pollIntervalMs: 3000 });
 * // On app teardown:
 * oracle.stop();
 * ```
 */
export function startPredictiveOracle(
  config: PredictiveOracleConfig
): PredictiveOracleHandle {
  const { engine, pollIntervalMs = 5_000 } = config;
  const thresholds: OracleThresholds = {
    warnRatio: config.thresholds?.warnRatio ?? 0.75,
    criticalRatio: config.thresholds?.criticalRatio ?? 0.90,
  };

  let latestSnapshot: MemorySnapshot | null = null;
  let warnAlertFired = false;
  let criticalAlertFired = false;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** Core polling callback. */
  function poll(): void {
    const snapshot = captureMemorySnapshot();
    if (snapshot === null) return;

    latestSnapshot = snapshot;
    engine.setMemorySnapshot(snapshot);

    const ratio = snapshot.heapUsageRatio;

    // CRITICAL threshold (90%)
    if (ratio >= thresholds.criticalRatio && !criticalAlertFired) {
      criticalAlertFired = true;
      warnAlertFired = true; // Suppress warn if we've already hit critical
      void engine.log(
        "fatal",
        "[PredictiveOracle] CRITICAL: JS heap approaching limit — triggering emergency state dump",
        {
          heapUsedMB: Math.round(snapshot.jsHeapUsedBytes / 1_048_576),
          heapLimitMB: Math.round(snapshot.jsHeapLimitBytes / 1_048_576),
          usageRatioPct: Math.round(ratio * 100),
        },
        "memory"
      );
      // Trigger immediate flush (best-effort state dump)
      void engine.flush();
      return;
    }

    // WARN threshold (75%)
    if (ratio >= thresholds.warnRatio && !warnAlertFired) {
      warnAlertFired = true;
      void engine.log(
        "warn",
        "[PredictiveOracle] WARNING: JS heap usage elevated — monitor for memory leak",
        {
          heapUsedMB: Math.round(snapshot.jsHeapUsedBytes / 1_048_576),
          heapLimitMB: Math.round(snapshot.jsHeapLimitBytes / 1_048_576),
          usageRatioPct: Math.round(ratio * 100),
        },
        "memory"
      );
      return;
    }

    // Reset alert flags when memory recovers
    if (ratio < thresholds.warnRatio * 0.85) {
      warnAlertFired = false;
      criticalAlertFired = false;
    }
  }

  // Start polling
  timerId = setInterval(poll, pollIntervalMs);
  running = true;
  // Run immediately on install
  poll();

  return {
    stop() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
      running = false;
    },
    getLatestSnapshot() {
      return latestSnapshot;
    },
    isRunning() {
      return running;
    },
  };
}
