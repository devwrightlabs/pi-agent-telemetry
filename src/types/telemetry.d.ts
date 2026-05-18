/**
 * @file telemetry.d.ts
 * @description Exhaustive TypeScript interfaces for @devright/pi-agent-telemetry.
 * Covers PCT privacy schemas, log levels, MCP tool definitions, health metrics,
 * compliance payloads, and React integration contracts. Zero `any` types.
 */

// ---------------------------------------------------------------------------
// Log Levels
// ---------------------------------------------------------------------------

/** Standard structured log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

// ---------------------------------------------------------------------------
// PCT Privacy Schema
// ---------------------------------------------------------------------------

/**
 * Represents a single field that has been scrubbed by the PCT privacy guard.
 * Contains the original field name, the scrub strategy applied, and a SHA-256
 * hash of the original value for deduplication without retaining PII.
 */
export interface ScrubRecord {
  /** The name of the field that was scrubbed. */
  readonly fieldName: string;
  /** The strategy used to scrub the value. */
  readonly strategy: "redact" | "hash" | "mask" | "drop";
  /** SHA-256 hash of the original value encoded as hex, for deduplication. */
  readonly valueHash: string;
}

/**
 * The result of passing a payload through the PCT privacy guard.
 * The sanitized payload is safe for transmission to the Devright dashboard.
 */
export interface PctPrivacyResult<T> {
  /** The sanitized payload with all PII/wallet data scrubbed. */
  readonly sanitized: T;
  /** A list of fields that were modified by the guard. */
  readonly scrubRecords: readonly ScrubRecord[];
  /** Whether any scrubbing was performed. */
  readonly wasDirty: boolean;
}

// ---------------------------------------------------------------------------
// Core Telemetry Event
// ---------------------------------------------------------------------------

/** Contextual metadata attached to every telemetry event. */
export interface TelemetryContext {
  /** ISO-8601 UTC timestamp when the event was captured. */
  readonly timestamp: string;
  /** Monotonic sequence number for ordering events within a session. */
  readonly sequence: number;
  /** Anonymous session identifier (no user PII). */
  readonly sessionId: string;
  /** App version string from the host application. */
  readonly appVersion: string;
  /** Pi SDK version string detected at runtime. */
  readonly piSdkVersion: string;
  /** Device platform string e.g. "Pi WebView / Android 14". */
  readonly platform: string;
  /** Geographic region code (ISO 3166-1 alpha-2), if available. */
  readonly region: string | null;
}

/** A single structured telemetry event ready for transmission. */
export interface TelemetryEvent {
  /** Unique event identifier (UUID v4). */
  readonly id: string;
  /** Severity level of the event. */
  readonly level: LogLevel;
  /** Human-readable message. */
  readonly message: string;
  /** Structured key/value payload — no PII allowed post-sanitization. */
  readonly payload: Record<string, string | number | boolean | null>;
  /** Attached error details, if applicable. */
  readonly error: SerializedError | null;
  /** Event category for filtering. */
  readonly category: TelemetryCategory;
  /** Contextual metadata. */
  readonly context: TelemetryContext;
}

/** Categories of telemetry events for server-side routing/filtering. */
export type TelemetryCategory =
  | "general"
  | "crash"
  | "performance"
  | "network"
  | "battery"
  | "memory"
  | "user-journey"
  | "smart-contract"
  | "compliance"
  | "audit"
  | "mcp";

/** A serialized representation of a JavaScript Error object. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly cause: string | null;
}

// ---------------------------------------------------------------------------
// TelemetryEngine Configuration
// ---------------------------------------------------------------------------

/** Configuration object passed to TelemetryEngine on initialization. */
export interface TelemetryEngineConfig {
  /**
   * The Devright dashboard ingestion endpoint URL.
   * Must use HTTPS.
   */
  readonly endpointUrl: string;
  /**
   * Your Devright API key. Stored in memory only — never persisted to disk.
   */
  readonly apiKey: string;
  /**
   * Minimum log level to capture. Events below this level are silently
   * discarded. Defaults to "info".
   */
  readonly minLevel?: LogLevel;
  /**
   * Number of events to accumulate before a batch flush is triggered.
   * Defaults to 20.
   */
  readonly batchSize?: number;
  /**
   * Maximum milliseconds between automatic batch flushes.
   * Defaults to 15_000 (15 seconds).
   */
  readonly flushIntervalMs?: number;
  /**
   * Maximum number of retry attempts for a failed batch upload.
   * Defaults to 3.
   */
  readonly maxRetries?: number;
  /**
   * Host app version string, included in every event context.
   */
  readonly appVersion: string;
  /**
   * Override the default session ID generator. Useful for testing.
   */
  readonly sessionIdOverride?: string;
  /**
   * When true, telemetry is silenced entirely (useful for unit tests).
   * Defaults to false.
   */
  readonly disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Batch Upload
// ---------------------------------------------------------------------------

/** The JSON body shape sent to the Devright ingestion endpoint. */
export interface TelemetryBatch {
  readonly schemaVersion: "1.0";
  readonly apiKey: string;
  readonly events: readonly TelemetryEvent[];
  readonly sentAt: string;
}

/** Result of a single batch upload attempt. */
export interface BatchUploadResult {
  readonly success: boolean;
  readonly statusCode: number | null;
  readonly errorMessage: string | null;
  readonly eventCount: number;
  readonly attemptNumber: number;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) Tool Definitions
// ---------------------------------------------------------------------------

/** JSON Schema primitive types. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** A single JSON Schema property descriptor. */
export interface JsonSchemaProperty {
  readonly type: JsonSchemaType | readonly JsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly items?: JsonSchemaProperty;
  readonly properties?: Record<string, JsonSchemaProperty>;
  readonly required?: readonly string[];
}

/** JSON Schema object shape used in MCP tool input schemas. */
export interface McpInputSchema {
  readonly type: "object";
  readonly properties: Record<string, JsonSchemaProperty>;
  readonly required?: readonly string[];
}

/** A single MCP tool definition exposing app health data to AI agents. */
export interface McpTool {
  /** Unique tool name following the `devright_<action>` naming convention. */
  readonly name: string;
  /** Human-readable description of what the tool does. */
  readonly description: string;
  /** JSON Schema describing the tool's input parameters. */
  readonly inputSchema: McpInputSchema;
}

/** The complete MCP server manifest for the pi-agent-telemetry library. */
export interface McpServerManifest {
  readonly protocolVersion: "2024-11-05";
  readonly serverName: "devright/pi-agent-telemetry";
  readonly serverVersion: string;
  readonly capabilities: {
    readonly tools: Record<string, boolean>;
  };
  readonly tools: readonly McpTool[];
}

// ---------------------------------------------------------------------------
// Health Monitoring
// ---------------------------------------------------------------------------

/** Memory usage snapshot captured by the predictive oracle. */
export interface MemorySnapshot {
  readonly timestamp: string;
  readonly jsHeapUsedBytes: number;
  readonly jsHeapTotalBytes: number;
  readonly jsHeapLimitBytes: number;
  readonly deviceRamUsedEstimateBytes: number | null;
  readonly heapUsageRatio: number;
}

/** Thresholds for the predictive oracle to trigger an emergency dump. */
export interface OracleThresholds {
  /** Heap usage ratio (0–1) that triggers a WARNING alert. Defaults to 0.75. */
  readonly warnRatio: number;
  /** Heap usage ratio (0–1) that triggers a CRITICAL emergency dump. Defaults to 0.90. */
  readonly criticalRatio: number;
}

/** Battery status snapshot. */
export interface BatterySnapshot {
  readonly timestamp: string;
  /** Battery level 0–1. */
  readonly level: number;
  /** Whether the device is currently charging. */
  readonly charging: boolean;
  /** Estimated seconds until battery is empty. */
  readonly dischargingTimeSeconds: number | null;
}

/** A detected battery drain anomaly. */
export interface BatteryDrainAnomaly {
  readonly detectedAt: string;
  /** Drain rate in percent/minute measured over the observation window. */
  readonly drainRatePercentPerMinute: number;
  /** Baseline drain rate for comparison. */
  readonly baselineDrainRatePercentPerMinute: number;
  /** The React component or hook suspected to be the culprit, if identified. */
  readonly suspectedSource: string | null;
}

/** A single user interaction captured by the journey tracker. */
export interface JourneyStep {
  readonly timestamp: string;
  /** Anonymous component name (e.g., "PaymentScreen"). */
  readonly component: string;
  /** The interaction type. */
  readonly interaction: "tap" | "swipe" | "scroll" | "focus" | "blur" | "mount" | "unmount";
  /** Optional anonymous metadata — no PII. */
  readonly metadata: Record<string, string | number | boolean> | null;
}

/** A complete user journey snapshot compiled on crash. */
export interface UserJourneyReport {
  readonly sessionId: string;
  readonly capturedAt: string;
  /** The last N steps before the crash. */
  readonly steps: readonly JourneyStep[];
  /** The component that was active when the crash was detected. */
  readonly crashComponent: string | null;
}

/** A single endpoint failure record for the network heatmap. */
export interface EndpointFailureRecord {
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly region: string | null;
  readonly timestamp: string;
}

/** Aggregated heatmap entry for a specific endpoint. */
export interface HeatmapEntry {
  readonly endpoint: string;
  readonly totalRequests: number;
  readonly failureCount: number;
  readonly failureRate: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly regionBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/** A WASM/smart-contract gas usage record for Protocol v23. */
export interface GasUsageRecord {
  readonly transactionId: string;
  readonly contractName: string;
  readonly operationName: string;
  readonly gasUsed: number;
  readonly gasLimit: number;
  readonly gasUsageRatio: number;
  readonly feePi: number;
  readonly timestamp: string;
  readonly spiked: boolean;
}

/** Thresholds for gas spike detection. */
export interface GasAlertThresholds {
  /** Gas usage ratio (0–1) that triggers a WARN. Defaults to 0.70. */
  readonly warnRatio: number;
  /** Gas usage ratio (0–1) that triggers a CRITICAL alert. Defaults to 0.90. */
  readonly criticalRatio: number;
  /** Absolute gas units increase vs rolling average that triggers a spike alert. */
  readonly absoluteSpikeThreshold: number;
}

/** A single dispute payload for CLAP review. */
export interface DisputePayload {
  readonly exportedAt: string;
  readonly formatVersion: "1.0";
  readonly transactionHash: string;
  /** Encrypted chat logs (AES-256 envelope — plaintext never leaves device). */
  readonly encryptedChatLogs: string;
  /** Array of telemetry events related to the transaction period. */
  readonly telemetrySnapshot: readonly TelemetryEvent[];
  /** Audit trail entries covering the transaction lifecycle. */
  readonly auditEntries: readonly AuditEntry[];
  /** SHA-256 integrity hash of the entire payload (excluding this field). */
  readonly integrityHash: string;
}

/** A single immutable audit trail entry. */
export interface AuditEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: AuditEventType;
  readonly actorId: string;
  readonly resourceId: string;
  /** SHA-256 hash of the state before the change. */
  readonly previousStateHash: string;
  /** SHA-256 hash of the state after the change. */
  readonly newStateHash: string;
  /** Hash of the preceding audit entry (chain-link integrity). */
  readonly previousEntryHash: string;
  /** Hash of this entry itself (computed on creation). */
  readonly entryHash: string;
}

/** Categories of auditable state changes. */
export type AuditEventType =
  | "AUTH_GRANT"
  | "AUTH_REVOKE"
  | "PAYMENT_APPROVE"
  | "PAYMENT_REJECT"
  | "PAYMENT_CANCEL"
  | "WALLET_LINK"
  | "WALLET_UNLINK"
  | "KYC_PASS"
  | "KYC_FAIL"
  | "PERMISSION_CHANGE"
  | "CONFIG_CHANGE"
  | "SESSION_START"
  | "SESSION_END";

// ---------------------------------------------------------------------------
// React Integration
// ---------------------------------------------------------------------------

/** The logger object exposed by the useTelemetry hook. */
export interface TelemetryLogger {
  debug(message: string, payload?: Record<string, string | number | boolean | null>): void;
  info(message: string, payload?: Record<string, string | number | boolean | null>): void;
  warn(message: string, payload?: Record<string, string | number | boolean | null>): void;
  error(message: string, error?: Error, payload?: Record<string, string | number | boolean | null>): void;
  fatal(message: string, error?: Error, payload?: Record<string, string | number | boolean | null>): void;
}

/** Health metrics exposed by the useTelemetry hook. */
export interface HealthMetrics {
  readonly memory: MemorySnapshot | null;
  readonly battery: BatterySnapshot | null;
  readonly apiLatencyMs: number | null;
}

/** The full value returned by the useTelemetry hook. */
export interface UseTelemetryReturn {
  readonly log: TelemetryLogger;
  readonly health: HealthMetrics;
  readonly isInitialized: boolean;
  /** Manually flush the event queue to the dashboard. */
  readonly flush: () => Promise<void>;
}

/** Props for the TelemetryProvider component. */
export interface TelemetryProviderProps {
  readonly config: TelemetryEngineConfig;
  readonly children: React.ReactNode;
}
