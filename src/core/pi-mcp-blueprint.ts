/**
 * @file pi-mcp-blueprint.ts
 * @description Model Context Protocol (MCP) schema definitions for the
 * @devright/pi-agent-telemetry library.
 *
 * Exposes a server manifest and tool catalog that allows external AI coding
 * agents (e.g., Claude, GPT-4o, Gemini) to securely query app health data
 * and autonomously diagnose bugs running inside the Pi Network webview.
 *
 * The manifest follows the MCP specification version 2024-11-05.
 * Tools are read-only: they query in-memory state and never mutate it.
 */

import type {
  McpServerManifest,
  McpTool,
  TelemetryEvent,
  MemorySnapshot,
  BatterySnapshot,
  HeatmapEntry,
  GasUsageRecord,
  UserJourneyReport,
  AuditEntry,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

/** Returns the last N telemetry events from the in-memory queue. */
const getRecentEvents: McpTool = {
  name: "devright_get_recent_events",
  description:
    "Returns the most recent telemetry events captured in the in-memory queue. " +
    "Useful for AI agents to understand what errors or warnings preceded a crash.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum number of events to return (1–200). Defaults to 50.",
      },
      level: {
        type: "string",
        description: "Filter to a specific log level (debug|info|warn|error|fatal).",
        enum: ["debug", "info", "warn", "error", "fatal"],
      },
      category: {
        type: "string",
        description: "Filter by event category.",
        enum: [
          "general",
          "crash",
          "performance",
          "network",
          "battery",
          "memory",
          "user-journey",
          "smart-contract",
          "compliance",
          "audit",
          "mcp",
        ],
      },
    },
  },
};

/** Returns current memory/heap usage snapshot. */
const getMemorySnapshot: McpTool = {
  name: "devright_get_memory_snapshot",
  description:
    "Returns the latest JavaScript heap and estimated device RAM usage. " +
    "Helps AI agents detect memory leaks or identify components consuming excessive heap.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/** Returns current battery status. */
const getBatteryStatus: McpTool = {
  name: "devright_get_battery_status",
  description:
    "Returns the current battery level, charging state, and any drain anomalies " +
    "detected in the current session.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/** Returns the API endpoint failure heatmap. */
const getNetworkHeatmap: McpTool = {
  name: "devright_get_network_heatmap",
  description:
    "Returns a ranked list of backend API endpoints by failure rate and latency. " +
    "AI agents can use this to pinpoint which Pi Horizon nodes or backend services " +
    "are causing the most user-facing errors.",
  inputSchema: {
    type: "object",
    properties: {
      topN: {
        type: "integer",
        description: "Return the top N entries by failure rate. Defaults to 10.",
      },
      region: {
        type: "string",
        description: "Filter heatmap to a specific ISO 3166-1 alpha-2 region code.",
      },
    },
  },
};

/** Returns the last user journey before a crash. */
const getUserJourney: McpTool = {
  name: "devright_get_user_journey",
  description:
    "Returns the anonymized sequence of UI interactions the user performed " +
    "immediately before the most recent crash. Enables AI agents to reproduce " +
    "bugs by replaying the exact interaction sequence.",
  inputSchema: {
    type: "object",
    properties: {
      maxSteps: {
        type: "integer",
        description: "Maximum journey steps to return. Defaults to 30.",
      },
    },
  },
};

/** Returns smart-contract gas usage records. */
const getGasUsage: McpTool = {
  name: "devright_get_gas_usage",
  description:
    "Returns Protocol v23 WASM smart-contract gas usage records. " +
    "AI agents can identify which contract operations are the most expensive " +
    "and suggest optimizations.",
  inputSchema: {
    type: "object",
    properties: {
      contractName: {
        type: "string",
        description: "Filter to a specific smart contract name.",
      },
      spikedOnly: {
        type: "boolean",
        description: "When true, returns only records where a gas spike was detected.",
      },
    },
  },
};

/** Returns the immutable audit trail. */
const getAuditTrail: McpTool = {
  name: "devright_get_audit_trail",
  description:
    "Returns the client-side immutable audit trail of critical state changes " +
    "(auth grants, payment approvals, etc.). Each entry is hash-chained for " +
    "tamper-proof integrity verification.",
  inputSchema: {
    type: "object",
    properties: {
      eventType: {
        type: "string",
        description: "Filter to a specific audit event type.",
        enum: [
          "AUTH_GRANT",
          "AUTH_REVOKE",
          "PAYMENT_APPROVE",
          "PAYMENT_REJECT",
          "PAYMENT_CANCEL",
          "WALLET_LINK",
          "WALLET_UNLINK",
          "KYC_PASS",
          "KYC_FAIL",
          "PERMISSION_CHANGE",
          "CONFIG_CHANGE",
          "SESSION_START",
          "SESSION_END",
        ],
      },
      limit: {
        type: "integer",
        description: "Maximum entries to return. Defaults to 50.",
      },
    },
  },
};

/** Triggers an immediate flush of the event queue. */
const flushEventQueue: McpTool = {
  name: "devright_flush_event_queue",
  description:
    "Triggers an immediate batch upload of all queued telemetry events to the " +
    "Devright dashboard. Useful when an AI agent needs fresh data after issuing " +
    "a series of diagnostic queries.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ---------------------------------------------------------------------------
// All Tools Registry
// ---------------------------------------------------------------------------

/** The canonical ordered list of all MCP tools exposed by this library. */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  getRecentEvents,
  getMemorySnapshot,
  getBatteryStatus,
  getNetworkHeatmap,
  getUserJourney,
  getGasUsage,
  getAuditTrail,
  flushEventQueue,
]);

// ---------------------------------------------------------------------------
// Server Manifest Builder
// ---------------------------------------------------------------------------

/**
 * Builds the complete MCP server manifest for the pi-agent-telemetry library.
 *
 * @param serverVersion - The semver string of the host library (e.g., "0.1.0").
 * @returns A fully-typed, immutable MCP server manifest.
 *
 * @example
 * ```ts
 * import { buildMcpManifest } from "./pi-mcp-blueprint.js";
 *
 * const manifest = buildMcpManifest("0.1.0");
 * // Send manifest to MCP client during initialization handshake
 * ```
 */
export function buildMcpManifest(serverVersion: string): McpServerManifest {
  return Object.freeze({
    protocolVersion: "2024-11-05",
    serverName: "devright/pi-agent-telemetry",
    serverVersion,
    capabilities: {
      tools: { listChanged: false },
    },
    tools: MCP_TOOLS,
  });
}

// ---------------------------------------------------------------------------
// MCP Request Handler Types
// ---------------------------------------------------------------------------

/** Union of all valid MCP tool names. */
export type McpToolName =
  | "devright_get_recent_events"
  | "devright_get_memory_snapshot"
  | "devright_get_battery_status"
  | "devright_get_network_heatmap"
  | "devright_get_user_journey"
  | "devright_get_gas_usage"
  | "devright_get_audit_trail"
  | "devright_flush_event_queue";

/** Input parameters for devright_get_recent_events. */
export interface GetRecentEventsParams {
  readonly limit?: number;
  readonly level?: "debug" | "info" | "warn" | "error" | "fatal";
  readonly category?: string;
}

/** Input parameters for devright_get_network_heatmap. */
export interface GetNetworkHeatmapParams {
  readonly topN?: number;
  readonly region?: string;
}

/** Input parameters for devright_get_user_journey. */
export interface GetUserJourneyParams {
  readonly maxSteps?: number;
}

/** Input parameters for devright_get_gas_usage. */
export interface GetGasUsageParams {
  readonly contractName?: string;
  readonly spikedOnly?: boolean;
}

/** Input parameters for devright_get_audit_trail. */
export interface GetAuditTrailParams {
  readonly eventType?: string;
  readonly limit?: number;
}

/** The in-memory data store that MCP tool handlers query. */
export interface McpDataStore {
  getRecentEvents(params: GetRecentEventsParams): readonly TelemetryEvent[];
  getMemorySnapshot(): MemorySnapshot | null;
  getBatteryStatus(): BatterySnapshot | null;
  getNetworkHeatmap(params: GetNetworkHeatmapParams): readonly HeatmapEntry[];
  getUserJourney(params: GetUserJourneyParams): UserJourneyReport | null;
  getGasUsage(params: GetGasUsageParams): readonly GasUsageRecord[];
  getAuditTrail(params: GetAuditTrailParams): readonly AuditEntry[];
  flushEventQueue(): Promise<void>;
}

/** The shape of an MCP tool call result. */
export interface McpToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: boolean;
}

/**
 * Dispatches an MCP tool call to the appropriate data store handler and returns
 * a structured MCP result object.
 *
 * @param toolName - The tool being called.
 * @param params - The input parameters for the tool.
 * @param store - The data store instance backing the tool.
 * @returns An McpToolResult ready to be serialized back to the AI client.
 */
export async function dispatchMcpToolCall(
  toolName: McpToolName,
  params: Record<string, unknown>,
  store: McpDataStore
): Promise<McpToolResult> {
  try {
    let data: unknown;

    switch (toolName) {
      case "devright_get_recent_events":
        data = store.getRecentEvents(params as GetRecentEventsParams);
        break;
      case "devright_get_memory_snapshot":
        data = store.getMemorySnapshot();
        break;
      case "devright_get_battery_status":
        data = store.getBatteryStatus();
        break;
      case "devright_get_network_heatmap":
        data = store.getNetworkHeatmap(params as GetNetworkHeatmapParams);
        break;
      case "devright_get_user_journey":
        data = store.getUserJourney(params as GetUserJourneyParams);
        break;
      case "devright_get_gas_usage":
        data = store.getGasUsage(params as GetGasUsageParams);
        break;
      case "devright_get_audit_trail":
        data = store.getAuditTrail(params as GetAuditTrailParams);
        break;
      case "devright_flush_event_queue":
        await store.flushEventQueue();
        data = { success: true, message: "Event queue flushed successfully." };
        break;
      default: {
        const exhaustiveCheck: never = toolName;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Unknown tool: ${exhaustiveCheck}` }),
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}
