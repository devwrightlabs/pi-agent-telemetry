# @devright/pi-agent-telemetry

> **Strictly typed TypeScript DevOps, Telemetry, and AI Orchestration engine for the native Pi Network mobile webview container.**

[![npm version](https://img.shields.io/npm/v/@devright/pi-agent-telemetry)](https://www.npmjs.com/package/@devright/pi-agent-telemetry)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## Why This Exists

Pi Network developers build inside a sandboxed mobile WebView — with no native DevTools, no crash reporting, and no visibility into what went wrong before a user quit. This library solves the "flying blind" problem by:

- **Safely extracting** webview errors, warnings, and unhandled rejections.
- **Monitoring** WASM execution costs (Protocol v23 gas), heap memory, and battery drain.
- **Providing MCP tooling** so AI coding agents (Claude, GPT-4o, Gemini) can autonomously query app health data and diagnose bugs.
- **Enforcing** Pi Core Team (PCT) data-privacy guidelines — all data is scrubbed of PII and raw wallet addresses before it leaves the device.

---

## Installation

\`\`\`bash
npm install @devright/pi-agent-telemetry
# peer dependencies
npm install react react-dom
\`\`\`

---

## Quick Start

\`\`\`tsx
import { TelemetryProvider, DevrightDashboardOverlay } from "@devright/pi-agent-telemetry";

export default function RootLayout({ children }) {
  return (
    <TelemetryProvider config={{
      endpointUrl: "https://ingest.devright.io/v1/events",
      apiKey: process.env.NEXT_PUBLIC_DEVRIGHT_API_KEY,
      appVersion: "1.0.0",
    }}>
      {children}
      {process.env.NODE_ENV !== "production" && <DevrightDashboardOverlay />}
    </TelemetryProvider>
  );
}
\`\`\`

\`\`\`tsx
import { useTelemetry } from "@devright/pi-agent-telemetry";

export function PaymentButton() {
  const { log } = useTelemetry();

  const handlePress = async () => {
    log.info("Payment initiated", { screen: "checkout" });
    try {
      await submitPayment();
    } catch (err) {
      log.error("Payment failed", err as Error, { screen: "checkout" });
    }
  };

  return <button onClick={handlePress}>Pay with Pi</button>;
}
\`\`\`

---

## PCT Privacy Compliance

All telemetry events pass through the **PCT Privacy Guard** before leaving the device. The guard scrubs:

| Pattern | Strategy | Example |
|---|---|---|
| Pi wallet addresses (Stellar G…) | Redact | \`GABCDEF…\` → \`[REDACTED:PI_WALLET]\` |
| Email addresses | Redact | \`user@example.com\` → \`[REDACTED:EMAIL]\` |
| Phone numbers | Redact | \`+1-555-123-4567\` → \`[REDACTED:PHONE]\` |
| IPv4 addresses | Redact | \`192.168.1.1\` → \`[REDACTED:IPV4]\` |
| Bearer tokens / API keys | Redact | \`Bearer eyJh…\` → \`[REDACTED:BEARER_TOKEN]\` |
| UUIDs | Redact | \`550e8400-…\` → \`[REDACTED:UUID]\` |

\`\`\`ts
import { runPctPrivacyGuard, scrubMessageSync } from "@devright/pi-agent-telemetry";

const result = await runPctPrivacyGuard({
  message: "User GABC123... made a payment",
  payload: { email: "user@example.com", amount: 3.14 },
});
// result.sanitized.message → "User [REDACTED:PI_WALLET] made a payment"
// result.wasDirty → true
\`\`\`

---

## Core — TelemetryEngine

\`\`\`ts
import { TelemetryEngine } from "@devright/pi-agent-telemetry";

const engine = new TelemetryEngine({
  endpointUrl: "https://ingest.devright.io/v1/events",
  apiKey: "YOUR_API_KEY",
  appVersion: "1.0.0",
  minLevel: "warn",
  batchSize: 25,
  flushIntervalMs: 10_000,
  maxRetries: 3,
});

await engine.info("App started");
await engine.error("API failed", new Error("timeout"), { endpoint: "/api/payments" });
await engine.flush();
await engine.destroy();
\`\`\`

### TelemetryEngineConfig

| Field | Type | Default | Description |
|---|---|---|---|
| \`endpointUrl\` | \`string\` | **required** | Devright ingestion URL (HTTPS) |
| \`apiKey\` | \`string\` | **required** | Devright API key (memory-only) |
| \`appVersion\` | \`string\` | **required** | Host app semver |
| \`minLevel\` | \`LogLevel\` | \`"info"\` | Minimum capture level |
| \`batchSize\` | \`number\` | \`20\` | Events before auto-flush |
| \`flushIntervalMs\` | \`number\` | \`15000\` | Max ms between flushes |
| \`maxRetries\` | \`number\` | \`3\` | Upload retry attempts |
| \`disabled\` | \`boolean\` | \`false\` | Silence telemetry (tests) |

---

## Health Monitoring

### Console Hijack

\`\`\`ts
import { installConsoleHijack } from "@devright/pi-agent-telemetry";

const handle = installConsoleHijack({ engine, interceptLog: false });
// Original console methods still called — DevTools unaffected
handle.remove(); // Restore originals
\`\`\`

### Predictive Memory Oracle

\`\`\`ts
import { startPredictiveOracle } from "@devright/pi-agent-telemetry";

const oracle = startPredictiveOracle({
  engine,
  pollIntervalMs: 5_000,
  thresholds: { warnRatio: 0.75, criticalRatio: 0.90 },
});
// Emits warn at 75%, emergency dump + flush at 90%
oracle.stop();
\`\`\`

### Battery Drain Monitor

\`\`\`ts
import { startBatteryDrainMonitor } from "@devright/pi-agent-telemetry";

const monitor = await startBatteryDrainMonitor({
  engine,
  anomalyMultiplier: 2.5,
});
monitor.registerSource("PaymentPollingEffect");
monitor.stop();
\`\`\`

### User Journey Tracker

\`\`\`ts
import { createUserJourneyTracker } from "@devright/pi-agent-telemetry";

const journey = createUserJourneyTracker({ engine, maxSteps: 50 });
journey.recordStep("HomeScreen", "mount");
journey.recordStep("PaymentButton", "tap", { itemId: "item_abc" });

// In error boundary:
const report = journey.compileCrashReport("CheckoutScreen");
\`\`\`

### Network Heatmap

\`\`\`ts
import { installNetworkHeatmap } from "@devright/pi-agent-telemetry";

const heatmap = installNetworkHeatmap({
  engine,
  region: "US",
  watchedPrefixes: ["/api", "https://api.minepi.com"],
});
const entries = heatmap.getHeatmap();
// [{ endpoint, failureRate, p50LatencyMs, p95LatencyMs, p99LatencyMs }]
heatmap.remove();
\`\`\`

---

## Compliance

### Smart Contract Gas Monitor

\`\`\`ts
import { createGasMonitor } from "@devright/pi-agent-telemetry";

const gasMonitor = createGasMonitor({ engine });
gasMonitor.recordExecution({
  transactionId: "tx_abc123",
  contractName: "PiPaymentEscrow",
  operationName: "transfer",
  gasUsed: 85_000,
  gasLimit: 100_000,
  feePi: 0.0001,
});
\`\`\`

### CLAP Legal Export

\`\`\`ts
import { createLegalExporter } from "@devright/pi-agent-telemetry";

const exporter = createLegalExporter({ engine });
const payload = await exporter.generateDisputePayload({
  transactionHash: "tx_hash_abc123",
  chatLogPlaintext: messages.join("\n"),
  encryptionKey: "a1b2c3d4...64-hex-chars...", // AES-256 key
});
// payload.integrityHash = SHA-256 of full payload body
// payload.encryptedChatLogs = AES-256-GCM ciphertext (IV:ciphertext)
const json = exporter.serializeToJson(payload);
\`\`\`

### Audit Trail

\`\`\`ts
import { createAuditTrail } from "@devright/pi-agent-telemetry";

const audit = createAuditTrail({ engine });
const entry = await audit.record({
  eventType: "PAYMENT_APPROVE",
  actorId: "session_hash_abc",
  resourceId: "payment:tx_xyz",
  previousState: JSON.stringify({ status: "pending" }),
  newState: JSON.stringify({ status: "approved" }),
});

const { valid } = await audit.verifyChain();
\`\`\`

---

## React Integration

### TelemetryProvider

\`\`\`tsx
import { TelemetryProvider } from "@devright/pi-agent-telemetry";

<TelemetryProvider config={{ endpointUrl, apiKey, appVersion: "1.0.0" }}>
  <App />
</TelemetryProvider>
\`\`\`

Auto-initializes on mount: console hijack, memory oracle, battery monitor, network heatmap, global error listeners, visibility-change flush.

### useTelemetry Hook

\`\`\`tsx
const { log, health, isInitialized, flush } = useTelemetry();

log.debug("...");
log.info("...", { key: "value" });
log.warn("...");
log.error("...", new Error("..."));
log.fatal("...", new Error("..."));

// health.memory → MemorySnapshot | null
// health.battery → BatterySnapshot | null
await flush();
\`\`\`

### DevrightDashboardOverlay

\`\`\`tsx
{process.env.NODE_ENV !== "production" && <DevrightDashboardOverlay />}
\`\`\`

Draggable overlay showing heap usage, battery, top failing endpoints, recent errors, and a flush button. Design: Background \`#0A0A0F\`, Accent \`#F0C040\`.

---

## MCP AI Blueprint

\`\`\`ts
import { buildMcpManifest, MCP_TOOLS, dispatchMcpToolCall } from "@devright/pi-agent-telemetry";

// Build manifest for MCP handshake
const manifest = buildMcpManifest("0.1.0");

// Dispatch an AI agent tool call
const result = await dispatchMcpToolCall(
  "devright_get_recent_events",
  { limit: 20, level: "error" },
  engine
);
\`\`\`

### Available MCP Tools

| Tool | Description |
|---|---|
| \`devright_get_recent_events\` | Last N events, filterable by level/category |
| \`devright_get_memory_snapshot\` | JS heap and RAM usage |
| \`devright_get_battery_status\` | Battery level and charging state |
| \`devright_get_network_heatmap\` | Endpoint failure rates and latency percentiles |
| \`devright_get_user_journey\` | Anonymized crash interaction sequence |
| \`devright_get_gas_usage\` | Protocol v23 WASM contract gas records |
| \`devright_get_audit_trail\` | Hash-chained audit log |
| \`devright_flush_event_queue\` | Triggers immediate batch upload |

---

## License

MIT © Devright Labs
