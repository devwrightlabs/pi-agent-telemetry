/**
 * @file pi-battery-drain-monitor.ts
 * @description Battery drain anomaly detector for Pi Network mobile webview apps.
 *
 * Uses the Battery Status API (W3C) to track real-time battery discharge.
 * Computes a rolling drain rate and compares it to a baseline (measured during
 * the first few minutes of app usage). If the current drain rate significantly
 * exceeds the baseline, an anomaly event is dispatched to the Devright dashboard.
 *
 * Developers can optionally register React `useEffect` hook labels so the monitor
 * can attempt to attribute drain anomalies to specific components.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type { BatterySnapshot, BatteryDrainAnomaly } from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// W3C Battery Status API Types
// ---------------------------------------------------------------------------

/** W3C Battery Status API interface (not in all TS lib defs). */
interface BatteryManager extends EventTarget {
  readonly charging: boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
  readonly level: number;
  onchargingchange: ((this: BatteryManager, ev: Event) => void) | null;
  ondischargingtimechange: ((this: BatteryManager, ev: Event) => void) | null;
  onlevelchange: ((this: BatteryManager, ev: Event) => void) | null;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?(): Promise<BatteryManager>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the battery drain monitor. */
export interface BatteryDrainMonitorConfig {
  /** TelemetryEngine to route alerts through. */
  readonly engine: TelemetryEngine;
  /**
   * Drain rate multiplier above baseline that triggers an anomaly alert.
   * E.g., 2.5 = "drain is 2.5x faster than normal". Defaults to 2.5.
   */
  readonly anomalyMultiplier?: number;
  /**
   * Minimum drain rate (% per minute) that must be observed before
   * comparisons are made. Prevents false positives at low activity.
   * Defaults to 0.05 (one full charge in ~33 hours).
   */
  readonly minDrainRateForAlert?: number;
  /**
   * Window size for the rolling drain rate calculation (number of samples).
   * Defaults to 6 (30-second samples → 3 minutes of data).
   */
  readonly rollingWindowSize?: number;
}

/** Handle returned by `startBatteryDrainMonitor`. */
export interface BatteryDrainMonitorHandle {
  /** Stops the monitor and removes all event listeners. */
  stop(): void;
  /** Returns the latest battery snapshot. */
  getLatestSnapshot(): BatterySnapshot | null;
  /**
   * Registers a human-readable label for a React effect or network loop
   * so it can be named in anomaly reports.
   * Call this from your useEffect registration code.
   */
  registerSource(label: string): void;
  /** Returns true if the monitor is currently active. */
  isActive(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a BatterySnapshot from a BatteryManager.
 *
 * @param battery - The W3C BatteryManager instance.
 * @returns A BatterySnapshot.
 */
function buildSnapshot(battery: BatteryManager): BatterySnapshot {
  return {
    timestamp: new Date().toISOString(),
    level: battery.level,
    charging: battery.charging,
    dischargingTimeSeconds: isFinite(battery.dischargingTime)
      ? battery.dischargingTime
      : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the battery drain monitor.
 *
 * Attempts to acquire a `BatteryManager` instance via `navigator.getBattery()`.
 * If the API is unavailable (e.g., iOS WebView, non-HTTPS context), the monitor
 * gracefully degrades and does nothing.
 *
 * @param config - Monitor configuration.
 * @returns A handle with `stop()`, `getLatestSnapshot()`, and `registerSource()`.
 *
 * @example
 * ```ts
 * const monitor = await startBatteryDrainMonitor({ engine });
 * monitor.registerSource("PaymentPollingEffect");
 * // On teardown:
 * monitor.stop();
 * ```
 */
export async function startBatteryDrainMonitor(
  config: BatteryDrainMonitorConfig
): Promise<BatteryDrainMonitorHandle> {
  const {
    engine,
    anomalyMultiplier = 2.5,
    minDrainRateForAlert = 0.05,
    rollingWindowSize = 6,
  } = config;

  let latestSnapshot: BatterySnapshot | null = null;
  let active = false;
  const registeredSources: string[] = [];

  // Baseline tracking
  const levelHistory: Array<{ level: number; time: number }> = [];
  let baselineDrainRate: number | null = null;
  let anomalyAlertFired = false;

  /**
   * Appends a level/time sample and (re)computes drain rates.
   * Emits anomaly events when appropriate.
   */
  function processSample(level: number): void {
    const now = Date.now();
    levelHistory.push({ level, time: now });

    // Keep only the rolling window
    while (levelHistory.length > rollingWindowSize * 2) {
      levelHistory.shift();
    }

    if (levelHistory.length < 2) return;

    const oldest = levelHistory[0];
    const newest = levelHistory[levelHistory.length - 1];

    if (oldest === undefined || newest === undefined) return;

    const deltaLevel = oldest.level - newest.level; // positive = draining
    const deltaMinutes = (newest.time - oldest.time) / 60_000;

    if (deltaMinutes < 0.1) return; // Need at least 6 seconds of data

    const currentDrainRate = deltaLevel / deltaMinutes; // % per minute

    // Build baseline from the first window of samples
    if (baselineDrainRate === null && levelHistory.length >= rollingWindowSize) {
      baselineDrainRate = currentDrainRate;
      void engine.log(
        "debug",
        "[BatteryDrainMonitor] Baseline drain rate established",
        { drainRatePctPerMin: currentDrainRate },
        "battery"
      );
      return;
    }

    if (baselineDrainRate === null) return;

    // Check for anomaly
    const isAbnormal =
      currentDrainRate >= minDrainRateForAlert &&
      baselineDrainRate > 0 &&
      currentDrainRate >= baselineDrainRate * anomalyMultiplier;

    if (isAbnormal && !anomalyAlertFired) {
      anomalyAlertFired = true;
      const anomaly: BatteryDrainAnomaly = {
        detectedAt: new Date().toISOString(),
        drainRatePercentPerMinute: currentDrainRate,
        baselineDrainRatePercentPerMinute: baselineDrainRate,
        suspectedSource:
          registeredSources.length > 0
            ? registeredSources[registeredSources.length - 1] ?? null
            : null,
      };

      void engine.log(
        "warn",
        `[BatteryDrainMonitor] ANOMALY: Battery draining ${(currentDrainRate / baselineDrainRate).toFixed(1)}x faster than baseline`,
        {
          currentDrainRatePctPerMin: currentDrainRate,
          baselineDrainRatePctPerMin: baselineDrainRate,
          suspectedSource: anomaly.suspectedSource ?? "unknown",
        },
        "battery"
      );
    }

    // Reset flag when drain normalizes
    if (
      baselineDrainRate > 0 &&
      currentDrainRate < baselineDrainRate * (anomalyMultiplier * 0.75)
    ) {
      anomalyAlertFired = false;
    }
  }

  // Attempt to acquire BatteryManager
  try {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== "function") {
      // Battery Status API not available — return a no-op handle
      return {
        stop: () => undefined,
        getLatestSnapshot: () => null,
        registerSource: () => undefined,
        isActive: () => false,
      };
    }

    const battery = await nav.getBattery();
    active = true;
    latestSnapshot = buildSnapshot(battery);
    engine.setBatterySnapshot(latestSnapshot);
    processSample(battery.level);

    const onLevelChange = (): void => {
      latestSnapshot = buildSnapshot(battery);
      engine.setBatterySnapshot(latestSnapshot);

      // Only track drain while discharging
      if (!battery.charging) {
        processSample(battery.level);
      } else {
        // Reset baseline on charge so we get a fresh measurement after
        baselineDrainRate = null;
        levelHistory.length = 0;
        anomalyAlertFired = false;
      }
    };

    battery.onlevelchange = onLevelChange;

    return {
      stop() {
        battery.onlevelchange = null;
        active = false;
      },
      getLatestSnapshot() {
        return latestSnapshot;
      },
      registerSource(label: string) {
        registeredSources.push(label);
      },
      isActive() {
        return active;
      },
    };
  } catch {
    // getBattery() rejected — non-HTTPS or unsupported context
    return {
      stop: () => undefined,
      getLatestSnapshot: () => null,
      registerSource: () => undefined,
      isActive: () => false,
    };
  }
}
