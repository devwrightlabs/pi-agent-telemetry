/**
 * @file pi-user-journey.ts
 * @description Anonymous user journey tracker for the Pi Network mobile webview.
 *
 * Tracks the exact sequence of UI components a user interacted with prior to
 * a crash, making bug reproduction effortless. All data is fully anonymized:
 *   - Component names are used (developer-controlled labels), not user names.
 *   - No user content, payment amounts, or identifiers are captured.
 *   - The buffer auto-truncates to the last `maxSteps` interactions.
 *
 * Integration pattern:
 *   1. Call `recordStep()` from your components' event handlers or effects.
 *   2. Call `compileCrashReport()` from your error boundary's `componentDidCatch`.
 *   3. The report is automatically forwarded to the TelemetryEngine.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type {
  JourneyStep,
  UserJourneyReport,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the user journey tracker. */
export interface UserJourneyConfig {
  /** TelemetryEngine to report journey data through. */
  readonly engine: TelemetryEngine;
  /**
   * Maximum number of journey steps to retain in memory.
   * Older steps are evicted on a FIFO basis. Defaults to 50.
   */
  readonly maxSteps?: number;
}

/** Handle returned by `createUserJourneyTracker`. */
export interface UserJourneyTrackerHandle {
  /**
   * Records a single user interaction step.
   * Call from component event handlers, `useEffect` mounts, etc.
   *
   * @param component - The name of the React component (e.g., "PaymentScreen").
   * @param interaction - The type of interaction.
   * @param metadata - Optional anonymous metadata (no PII).
   */
  recordStep(
    component: string,
    interaction: JourneyStep["interaction"],
    metadata?: Record<string, string | number | boolean>
  ): void;

  /**
   * Compiles and returns a crash report from the current journey buffer.
   * Also dispatches the report to the TelemetryEngine.
   *
   * @param crashComponent - The component name where the crash occurred, if known.
   * @returns The compiled UserJourneyReport.
   */
  compileCrashReport(crashComponent?: string): UserJourneyReport;

  /** Returns a read-only copy of the current journey buffer. */
  getJourneyBuffer(): readonly JourneyStep[];

  /** Clears the journey buffer (e.g., on successful screen navigation). */
  clearBuffer(): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new user journey tracker instance.
 *
 * @param config - Tracker configuration.
 * @returns A handle with `recordStep()`, `compileCrashReport()`, and helpers.
 *
 * @example
 * ```ts
 * const journey = createUserJourneyTracker({ engine, maxSteps: 30 });
 *
 * // In your component:
 * journey.recordStep("HomeScreen", "mount");
 * journey.recordStep("PaymentButton", "tap", { itemId: "item_abc" });
 *
 * // In your error boundary:
 * journey.compileCrashReport("PaymentScreen");
 * ```
 */
export function createUserJourneyTracker(
  config: UserJourneyConfig
): UserJourneyTrackerHandle {
  const { engine, maxSteps = 50 } = config;
  const buffer: JourneyStep[] = [];

  // Derive a stable anonymous session ID from the engine (best-effort)
  // by capturing the first event's sessionId, or generating a placeholder.
  const sessionId = `journey_${Date.now().toString(36)}`;

  function recordStep(
    component: string,
    interaction: JourneyStep["interaction"],
    metadata?: Record<string, string | number | boolean>
  ): void {
    const step: JourneyStep = {
      timestamp: new Date().toISOString(),
      component,
      interaction,
      metadata: metadata ?? null,
    };

    buffer.push(step);

    // Evict oldest entries to enforce the cap
    while (buffer.length > maxSteps) {
      buffer.shift();
    }
  }

  function compileCrashReport(crashComponent?: string): UserJourneyReport {
    const report: UserJourneyReport = {
      sessionId,
      capturedAt: new Date().toISOString(),
      steps: [...buffer],
      crashComponent: crashComponent ?? null,
    };

    // Persist to engine so MCP tools can query it
    engine.setUserJourney(report);

    // Dispatch as a telemetry event
    void engine.log(
      "error",
      `[UserJourney] Crash detected${crashComponent ? ` in ${crashComponent}` : ""}. Journey compiled (${buffer.length} steps).`,
      {
        stepCount: buffer.length,
        crashComponent: crashComponent ?? "unknown",
      },
      "user-journey"
    );

    return report;
  }

  function getJourneyBuffer(): readonly JourneyStep[] {
    return [...buffer];
  }

  function clearBuffer(): void {
    buffer.length = 0;
  }

  return {
    recordStep,
    compileCrashReport,
    getJourneyBuffer,
    clearBuffer,
  };
}
