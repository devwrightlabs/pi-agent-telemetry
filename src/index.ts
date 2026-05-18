/**
 * @file index.ts
 * @description Main entry point for @devright/pi-agent-telemetry.
 *
 * Re-exports all public modules, types, React hooks, and components.
 *
 * @example
 * ```ts
 * import {
 *   TelemetryEngine,
 *   TelemetryProvider,
 *   useTelemetry,
 *   DevrightDashboardOverlay,
 *   runPctPrivacyGuard,
 *   buildMcpManifest,
 *   createAuditTrail,
 *   createLegalExporter,
 *   createGasMonitor,
 * } from "@devright/pi-agent-telemetry";
 * ```
 */

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export { TelemetryEngine } from "./core/TelemetryEngine.js";
export { runPctPrivacyGuard, scrubMessageSync, scrubPayloadSync } from "./core/pi-pct-privacy-guard.js";
export {
  buildMcpManifest,
  MCP_TOOLS,
  dispatchMcpToolCall,
} from "./core/pi-mcp-blueprint.js";

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export { installConsoleHijack, isConsoleHijackActive } from "./health/pi-console-hijack.js";
export { startPredictiveOracle } from "./health/pi-predictive-oracle.js";
export { startBatteryDrainMonitor } from "./health/pi-battery-drain-monitor.js";
export { createUserJourneyTracker } from "./health/pi-user-journey.js";
export { installNetworkHeatmap } from "./health/pi-network-heatmap.js";

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export { createGasMonitor } from "./compliance/pi-smart-contract-gas.js";
export { createLegalExporter } from "./compliance/pi-legal-export.js";
export { createAuditTrail } from "./compliance/pi-audit-trail.js";

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

export {
  TelemetryProvider,
  TelemetryContext,
  useTelemetryContext,
} from "./react/TelemetryProvider.js";
export { useTelemetry } from "./react/useTelemetry.js";
export { DevrightDashboardOverlay } from "./react/DevrightDashboardOverlay.js";

// ---------------------------------------------------------------------------
// Types (re-exported for consumer convenience)
// ---------------------------------------------------------------------------

export type {
  // Log levels
  LogLevel,
  TelemetryCategory,

  // Privacy
  ScrubRecord,
  PctPrivacyResult,

  // Core events
  TelemetryContext as TelemetryEventContext,
  TelemetryEvent,
  SerializedError,

  // Config
  TelemetryEngineConfig,
  TelemetryBatch,
  BatchUploadResult,

  // MCP
  McpTool,
  McpInputSchema,
  McpServerManifest,
  JsonSchemaProperty,
  JsonSchemaType,

  // Health
  MemorySnapshot,
  OracleThresholds,
  BatterySnapshot,
  BatteryDrainAnomaly,
  JourneyStep,
  UserJourneyReport,
  EndpointFailureRecord,
  HeatmapEntry,

  // Compliance
  GasUsageRecord,
  GasAlertThresholds,
  DisputePayload,
  AuditEntry,
  AuditEventType,

  // React
  TelemetryLogger,
  HealthMetrics,
  UseTelemetryReturn,
  TelemetryProviderProps,
} from "./types/telemetry.js";

export type { TelemetryContextValue } from "./react/TelemetryProvider.js";

export type {
  GuardInput,
} from "./core/pi-pct-privacy-guard.js";

export type {
  McpDataStore,
  McpToolName,
  McpToolResult,
  GetRecentEventsParams,
  GetNetworkHeatmapParams,
  GetUserJourneyParams,
  GetGasUsageParams,
  GetAuditTrailParams,
} from "./core/pi-mcp-blueprint.js";

export type {
  ConsoleHijackConfig,
  ConsoleHijackHandle,
} from "./health/pi-console-hijack.js";

export type {
  PredictiveOracleConfig,
  PredictiveOracleHandle,
} from "./health/pi-predictive-oracle.js";

export type {
  BatteryDrainMonitorConfig,
  BatteryDrainMonitorHandle,
} from "./health/pi-battery-drain-monitor.js";

export type {
  UserJourneyConfig,
  UserJourneyTrackerHandle,
} from "./health/pi-user-journey.js";

export type {
  NetworkHeatmapConfig,
  NetworkHeatmapHandle,
} from "./health/pi-network-heatmap.js";

export type {
  SmartContractGasConfig,
  GasMonitorHandle,
  GasRecordInput,
} from "./compliance/pi-smart-contract-gas.js";

export type {
  LegalExportConfig,
  LegalExporterHandle,
  DisputeExportInput,
} from "./compliance/pi-legal-export.js";

export type {
  AuditTrailConfig,
  AuditTrailHandle,
  AuditEventInput,
} from "./compliance/pi-audit-trail.js";
