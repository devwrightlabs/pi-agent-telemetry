/**
 * @file TelemetryEngine.ts
 * @description Master orchestrator class for @devright/pi-agent-telemetry.
 *
 * Manages the full lifecycle of telemetry events:
 *   1. Receives raw log calls from the application layer.
 *   2. Enriches each event with session context.
 *   3. Passes every event through the PCT privacy guard before queuing.
 *   4. Accumulates events in a bounded in-memory queue.
 *   5. Batch-uploads queued events to the Devright dashboard on a configurable
 *      interval or when the batch size threshold is reached.
 *   6. Implements exponential back-off retry logic with configurable attempts.
 *   7. Exposes an McpDataStore interface so MCP tools can query live state.
 */

import { runPctPrivacyGuard } from "./pi-pct-privacy-guard.js";
import type {
  TelemetryEngineConfig,
  TelemetryEvent,
  TelemetryContext,
  TelemetryCategory,
  LogLevel,
  SerializedError,
  TelemetryBatch,
  BatchUploadResult,
  MemorySnapshot,
  BatterySnapshot,
  HeatmapEntry,
  GasUsageRecord,
  UserJourneyReport,
  AuditEntry,
} from "../types/telemetry.js";
import type {
  McpDataStore,
  GetRecentEventsParams,
  GetNetworkHeatmapParams,
  GetUserJourneyParams,
  GetGasUsageParams,
  GetAuditTrailParams,
} from "./pi-mcp-blueprint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a UUID v4 string using the Web Crypto API. */
function uuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (cryptographically secure, broader support
  // than randomUUID — available in all modern browsers including Android WebView 4.4+)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // Set version (4) and variant bits per RFC 4122
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(
    "[pi-agent-telemetry] The Web Crypto API (crypto.getRandomValues) is required " +
    "but not available in this environment. Ensure the app runs in a secure context (HTTPS)."
  );
}

/** Returns an ISO-8601 UTC timestamp string. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Serializes a JS Error into a plain object. */
function serializeError(err: Error): SerializedError {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack ?? null,
    cause: err.cause instanceof Error
      ? err.cause.message
      : typeof err.cause === "string"
      ? err.cause
      : null,
  };
}

/** Clamps a number between min and max (inclusive). */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Detects the Pi SDK version from the global window object (best-effort). */
function detectPiSdkVersion(): string {
  try {
    // The Pi SDK injects `window.Pi` with a version property
    if (
      typeof window !== "undefined" &&
      "Pi" in window &&
      typeof (window as Record<string, unknown>)["Pi"] === "object"
    ) {
      const pi = (window as Record<string, unknown>)["Pi"] as Record<string, unknown>;
      if (typeof pi["version"] === "string") {
        return pi["version"];
      }
    }
  } catch {
    // Ignore — running outside browser context (e.g., SSR/tests)
  }
  return "unknown";
}

/** Detects the device platform string from the user agent. */
function detectPlatform(): string {
  try {
    if (typeof navigator !== "undefined") {
      return navigator.userAgent ?? "unknown";
    }
  } catch {
    // Ignore
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Log Level Priority Map
// ---------------------------------------------------------------------------

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

// ---------------------------------------------------------------------------
// TelemetryEngine Class
// ---------------------------------------------------------------------------

/**
 * The central telemetry orchestrator.
 *
 * Instantiate once per application, typically inside a React Context Provider.
 * All log methods are safe to call from any component or hook.
 *
 * @example
 * ```ts
 * const engine = new TelemetryEngine({
 *   endpointUrl: "https://ingest.devright.io/v1/events",
 *   apiKey: process.env.DEVRIGHT_API_KEY!,
 *   appVersion: "1.2.3",
 *   batchSize: 25,
 *   flushIntervalMs: 10_000,
 * });
 *
 * engine.log("info", "App started", {}, "general");
 * ```
 */
export class TelemetryEngine implements McpDataStore {
  // -------------------------------------------------------------------------
  // Private State
  // -------------------------------------------------------------------------

  private readonly config: Required<TelemetryEngineConfig>;
  private readonly sessionId: string;
  private sequence = 0;
  private readonly queue: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  // Injected state from health/compliance modules (populated via setters)
  private latestMemory: MemorySnapshot | null = null;
  private latestBattery: BatterySnapshot | null = null;
  private latestJourney: UserJourneyReport | null = null;
  private readonly heatmapEntries: Map<string, HeatmapEntry> = new Map();
  private readonly gasRecords: GasUsageRecord[] = [];
  private readonly auditEntries: AuditEntry[] = [];

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Creates a new TelemetryEngine instance.
   *
   * @param config - Engine configuration. See TelemetryEngineConfig for details.
   */
  constructor(config: TelemetryEngineConfig) {
    this.config = {
      endpointUrl: config.endpointUrl,
      apiKey: config.apiKey,
      minLevel: config.minLevel ?? "info",
      batchSize: clamp(config.batchSize ?? 20, 1, 500),
      flushIntervalMs: clamp(config.flushIntervalMs ?? 15_000, 1_000, 300_000),
      maxRetries: clamp(config.maxRetries ?? 3, 0, 10),
      appVersion: config.appVersion,
      sessionIdOverride: config.sessionIdOverride ?? "",
      disabled: config.disabled ?? false,
    };

    this.sessionId = this.config.sessionIdOverride || uuidV4();

    if (!this.config.disabled) {
      this.startFlushTimer();
    }
  }

  // -------------------------------------------------------------------------
  // Public Log API
  // -------------------------------------------------------------------------

  /**
   * Captures a telemetry event. Passes the event through the PCT privacy guard
   * before queuing it for upload.
   *
   * @param level - Severity level.
   * @param message - Human-readable message (PII will be scrubbed).
   * @param payload - Structured key/value data (PII will be scrubbed).
   * @param category - Event category for dashboard routing.
   * @param error - Optional JavaScript Error to attach.
   */
  async log(
    level: LogLevel,
    message: string,
    payload: Record<string, string | number | boolean | null>,
    category: TelemetryCategory = "general",
    error?: Error
  ): Promise<void> {
    if (this.config.disabled) return;
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return;
    }

    try {
      // Run PCT privacy guard
      const guardResult = await runPctPrivacyGuard({ message, payload });

      const context = this.buildContext();
      const event: TelemetryEvent = {
        id: uuidV4(),
        level,
        message: guardResult.sanitized.message,
        payload: guardResult.sanitized.payload,
        error: error ? serializeError(error) : null,
        category,
        context,
      };

      this.enqueue(event);

      // Trigger immediate flush if batch size reached
      if (this.queue.length >= this.config.batchSize) {
        void this.flush();
      }
    } catch (err) {
      // Never let telemetry crash the host application
      if (typeof console !== "undefined") {
        console.warn("[pi-agent-telemetry] Failed to log event:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Convenience Wrappers
  // -------------------------------------------------------------------------

  /** @see {@link log} */
  debug(message: string, payload: Record<string, string | number | boolean | null> = {}): Promise<void> {
    return this.log("debug", message, payload, "general");
  }

  /** @see {@link log} */
  info(message: string, payload: Record<string, string | number | boolean | null> = {}): Promise<void> {
    return this.log("info", message, payload, "general");
  }

  /** @see {@link log} */
  warn(message: string, payload: Record<string, string | number | boolean | null> = {}): Promise<void> {
    return this.log("warn", message, payload, "general");
  }

  /** @see {@link log} */
  error(
    message: string,
    error?: Error,
    payload: Record<string, string | number | boolean | null> = {}
  ): Promise<void> {
    return this.log("error", message, payload, "general", error);
  }

  /** @see {@link log} */
  fatal(
    message: string,
    error?: Error,
    payload: Record<string, string | number | boolean | null> = {}
  ): Promise<void> {
    return this.log("fatal", message, payload, "crash", error);
  }

  // -------------------------------------------------------------------------
  // Flush / Upload
  // -------------------------------------------------------------------------

  /**
   * Flushes all queued events to the Devright dashboard in a single batch
   * upload. Implements exponential back-off retry on failure.
   *
   * This method is safe to call manually at any time (e.g., before the app
   * is unloaded via `visibilitychange` events).
   *
   * @returns The result of the final upload attempt.
   */
  async flush(): Promise<BatchUploadResult> {
    if (this.config.disabled || this.queue.length === 0) {
      return {
        success: true,
        statusCode: null,
        errorMessage: null,
        eventCount: 0,
        attemptNumber: 0,
      };
    }

    // Drain the queue atomically to avoid duplicate sends
    const batch = this.queue.splice(0, this.queue.length);
    return this.uploadBatch(batch);
  }

  // -------------------------------------------------------------------------
  // State Injection Setters (used by health/compliance modules)
  // -------------------------------------------------------------------------

  /** Called by the predictive oracle to update the memory snapshot. */
  setMemorySnapshot(snapshot: MemorySnapshot): void {
    this.latestMemory = snapshot;
  }

  /** Called by the battery drain monitor to update the battery snapshot. */
  setBatterySnapshot(snapshot: BatterySnapshot): void {
    this.latestBattery = snapshot;
  }

  /** Called by the user journey tracker to update the journey. */
  setUserJourney(journey: UserJourneyReport): void {
    this.latestJourney = journey;
  }

  /** Called by the network heatmap module to update an endpoint entry. */
  upsertHeatmapEntry(entry: HeatmapEntry): void {
    this.heatmapEntries.set(entry.endpoint, entry);
  }

  /** Called by the smart-contract gas monitor to record a gas usage event. */
  addGasRecord(record: GasUsageRecord): void {
    this.gasRecords.push(record);
    // Prevent unbounded growth
    if (this.gasRecords.length > 500) {
      this.gasRecords.splice(0, this.gasRecords.length - 500);
    }
  }

  /** Called by the audit trail module to append an audit entry. */
  addAuditEntry(entry: AuditEntry): void {
    this.auditEntries.push(entry);
  }

  // -------------------------------------------------------------------------
  // McpDataStore Interface Implementation
  // -------------------------------------------------------------------------

  /** Returns the most recent queued events, optionally filtered. */
  getRecentEvents(params: GetRecentEventsParams): readonly TelemetryEvent[] {
    const limit = clamp(params.limit ?? 50, 1, 200);
    let results: TelemetryEvent[] = [...this.queue];

    if (params.level !== undefined) {
      results = results.filter((e) => e.level === params.level);
    }
    if (params.category !== undefined) {
      results = results.filter((e) => e.category === params.category);
    }

    return results.slice(-limit);
  }

  /** Returns the latest memory snapshot. */
  getMemorySnapshot(): MemorySnapshot | null {
    return this.latestMemory;
  }

  /** Returns the latest battery snapshot. */
  getBatteryStatus(): BatterySnapshot | null {
    return this.latestBattery;
  }

  /** Returns heatmap entries sorted by failure rate descending. */
  getNetworkHeatmap(params: GetNetworkHeatmapParams): readonly HeatmapEntry[] {
    const topN = clamp(params.topN ?? 10, 1, 100);
    let entries = Array.from(this.heatmapEntries.values());

    if (params.region !== undefined) {
      entries = entries.filter(
        (e) => (e.regionBreakdown[params.region ?? ""] ?? 0) > 0
      );
    }

    return entries
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, topN);
  }

  /** Returns the latest user journey report. */
  getUserJourney(params: GetUserJourneyParams): UserJourneyReport | null {
    if (this.latestJourney === null) return null;
    const maxSteps = clamp(params.maxSteps ?? 30, 1, 200);
    const steps = this.latestJourney.steps.slice(-maxSteps);
    return { ...this.latestJourney, steps };
  }

  /** Returns gas usage records, optionally filtered. */
  getGasUsage(params: GetGasUsageParams): readonly GasUsageRecord[] {
    let records = [...this.gasRecords];
    if (params.contractName !== undefined) {
      records = records.filter((r) => r.contractName === params.contractName);
    }
    if (params.spikedOnly === true) {
      records = records.filter((r) => r.spiked);
    }
    return records;
  }

  /** Returns audit trail entries, optionally filtered. */
  getAuditTrail(params: GetAuditTrailParams): readonly AuditEntry[] {
    const limit = clamp(params.limit ?? 50, 1, 500);
    let entries = [...this.auditEntries];
    if (params.eventType !== undefined) {
      entries = entries.filter((e) => e.eventType === params.eventType);
    }
    return entries.slice(-limit);
  }

  /** Triggers an immediate flush. */
  async flushEventQueue(): Promise<void> {
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Destroys the engine: stops the flush timer, flushes remaining events,
   * and prevents any future logging. Call this during app teardown.
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.stopFlushTimer();
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private buildContext(): TelemetryContext {
    return {
      timestamp: nowIso(),
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      appVersion: this.config.appVersion,
      piSdkVersion: detectPiSdkVersion(),
      platform: detectPlatform(),
      region: null, // Populated by the network heatmap module if available
    };
  }

  private enqueue(event: TelemetryEvent): void {
    this.queue.push(event);
    // Hard cap to prevent unbounded memory growth in pathological cases
    if (this.queue.length > 1_000) {
      this.queue.splice(0, this.queue.length - 1_000);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Uploads a batch of events with exponential back-off retry.
   *
   * @param events - The drained batch to upload.
   * @returns The result of the final attempt.
   */
  private async uploadBatch(events: TelemetryEvent[]): Promise<BatchUploadResult> {
    const body: TelemetryBatch = {
      schemaVersion: "1.0",
      apiKey: this.config.apiKey,
      events,
      sentAt: nowIso(),
    };

    let lastResult: BatchUploadResult = {
      success: false,
      statusCode: null,
      errorMessage: "Not attempted",
      eventCount: events.length,
      attemptNumber: 0,
    };

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt++) {
      try {
        const response = await fetch(this.config.endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Devright-Api-Key": this.config.apiKey,
            "X-Devright-Schema-Version": "1.0",
          },
          body: JSON.stringify(body),
          // Keep-alive for faster subsequent requests
          keepalive: true,
        });

        lastResult = {
          success: response.ok,
          statusCode: response.status,
          errorMessage: response.ok
            ? null
            : `HTTP ${response.status}: ${response.statusText}`,
          eventCount: events.length,
          attemptNumber: attempt,
        };

        if (response.ok) {
          return lastResult;
        }

        // Non-retriable status codes (4xx except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return lastResult;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Network error";
        lastResult = {
          success: false,
          statusCode: null,
          errorMessage,
          eventCount: events.length,
          attemptNumber: attempt,
        };
      }

      // Exponential back-off: 1s, 2s, 4s, ...
      if (attempt <= this.config.maxRetries) {
        const delayMs = Math.min(1_000 * Math.pow(2, attempt - 1), 30_000);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // All retries exhausted — re-queue events (best effort, no infinite loops)
    if (this.queue.length + events.length <= 1_000) {
      this.queue.unshift(...events);
    }

    return lastResult;
  }
}
