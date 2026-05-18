/**
 * @file pi-smart-contract-gas.ts
 * @description Protocol v23 native Rust WASM smart-contract gas usage monitor.
 *
 * Tracks gas consumption for on-chain transactions and alerts developers when
 * execution costs spike due to inefficient contract code. Integrates with the
 * TelemetryEngine to surface gas anomalies on the Devright dashboard.
 *
 * Protocol v23 uses a Rust/WASM execution environment with per-operation gas
 * metering. This module records each transaction's gas used vs. limit and
 * computes a rolling average to detect spikes.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type {
  GasUsageRecord,
  GasAlertThresholds,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the gas usage monitor. */
export interface SmartContractGasConfig {
  /** TelemetryEngine to route alerts through. */
  readonly engine: TelemetryEngine;
  /** Alert thresholds for gas usage spikes. */
  readonly thresholds?: Partial<GasAlertThresholds>;
  /**
   * Number of records to include in the rolling average baseline.
   * Defaults to 10.
   */
  readonly rollingWindowSize?: number;
}

/** Input provided when recording a contract execution. */
export interface GasRecordInput {
  /** The transaction hash or ID (will be stored as-is; do not pass raw wallet addresses). */
  readonly transactionId: string;
  /** Human-readable name of the smart contract (e.g., "PiPaymentEscrow"). */
  readonly contractName: string;
  /** The specific operation within the contract (e.g., "transfer", "approve"). */
  readonly operationName: string;
  /** Actual gas units consumed by the execution. */
  readonly gasUsed: number;
  /** Maximum gas units allowed for the transaction. */
  readonly gasLimit: number;
  /** Transaction fee in Pi (π). */
  readonly feePi: number;
}

/** Handle returned by `createGasMonitor`. */
export interface GasMonitorHandle {
  /**
   * Records a completed contract execution and emits telemetry if thresholds
   * are breached.
   *
   * @param input - The gas usage data from the completed transaction.
   * @returns The created GasUsageRecord.
   */
  recordExecution(input: GasRecordInput): GasUsageRecord;

  /** Returns all recorded gas usage entries. */
  getRecords(): readonly GasUsageRecord[];

  /**
   * Returns the current rolling average gas usage ratio (0–1) for a
   * specific contract, or null if fewer than 2 records exist.
   */
  getRollingAverage(contractName: string): number | null;

  /** Clears all stored records. */
  clearRecords(): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a smart-contract gas usage monitor instance.
 *
 * @param config - Gas monitor configuration.
 * @returns A GasMonitorHandle with `recordExecution()` and accessor methods.
 *
 * @example
 * ```ts
 * const gasMonitor = createGasMonitor({ engine });
 *
 * // After a contract call resolves:
 * gasMonitor.recordExecution({
 *   transactionId: "tx_abc",
 *   contractName: "PiPaymentEscrow",
 *   operationName: "transfer",
 *   gasUsed: 42_000,
 *   gasLimit: 100_000,
 *   feePi: 0.0001,
 * });
 * ```
 */
export function createGasMonitor(
  config: SmartContractGasConfig
): GasMonitorHandle {
  const { engine, rollingWindowSize = 10 } = config;
  const thresholds: GasAlertThresholds = {
    warnRatio: config.thresholds?.warnRatio ?? 0.70,
    criticalRatio: config.thresholds?.criticalRatio ?? 0.90,
    absoluteSpikeThreshold: config.thresholds?.absoluteSpikeThreshold ?? 20_000,
  };

  const records: GasUsageRecord[] = [];
  // Per-contract rolling averages
  const rollingHistory = new Map<string, number[]>();

  function getRollingAverage(contractName: string): number | null {
    const history = rollingHistory.get(contractName);
    if (history === undefined || history.length < 2) return null;
    const sum = history.reduce((a, b) => a + b, 0);
    return sum / history.length;
  }

  function recordExecution(input: GasRecordInput): GasUsageRecord {
    const gasUsageRatio = input.gasLimit > 0 ? input.gasUsed / input.gasLimit : 0;
    const rollingAvg = getRollingAverage(input.contractName);

    // Detect spike based on absolute delta vs rolling average
    const isSpiked =
      gasUsageRatio >= thresholds.criticalRatio ||
      (rollingAvg !== null &&
        input.gasUsed - rollingAvg * input.gasLimit > thresholds.absoluteSpikeThreshold);

    const record: GasUsageRecord = {
      transactionId: input.transactionId,
      contractName: input.contractName,
      operationName: input.operationName,
      gasUsed: input.gasUsed,
      gasLimit: input.gasLimit,
      gasUsageRatio,
      feePi: input.feePi,
      timestamp: new Date().toISOString(),
      spiked: isSpiked,
    };

    records.push(record);
    // Prevent unbounded growth
    if (records.length > 500) records.shift();

    // Update rolling history
    const history = rollingHistory.get(input.contractName) ?? [];
    history.push(gasUsageRatio);
    if (history.length > rollingWindowSize) history.shift();
    rollingHistory.set(input.contractName, history);

    // Persist to engine for MCP queries
    engine.addGasRecord(record);

    // Emit telemetry alerts based on thresholds
    if (gasUsageRatio >= thresholds.criticalRatio) {
      void engine.log(
        "error",
        `[GasMonitor] CRITICAL: ${input.contractName}.${input.operationName} used ${Math.round(gasUsageRatio * 100)}% of gas limit`,
        {
          contractName: input.contractName,
          operationName: input.operationName,
          gasUsed: input.gasUsed,
          gasLimit: input.gasLimit,
          gasUsageRatioPct: Math.round(gasUsageRatio * 100),
          feePi: input.feePi,
          transactionId: input.transactionId,
        },
        "smart-contract"
      );
    } else if (gasUsageRatio >= thresholds.warnRatio) {
      void engine.log(
        "warn",
        `[GasMonitor] WARNING: ${input.contractName}.${input.operationName} used ${Math.round(gasUsageRatio * 100)}% of gas limit`,
        {
          contractName: input.contractName,
          operationName: input.operationName,
          gasUsed: input.gasUsed,
          gasLimit: input.gasLimit,
          gasUsageRatioPct: Math.round(gasUsageRatio * 100),
          feePi: input.feePi,
        },
        "smart-contract"
      );
    } else if (isSpiked && rollingAvg !== null) {
      void engine.log(
        "warn",
        `[GasMonitor] SPIKE: ${input.contractName}.${input.operationName} gas usage jumped significantly above rolling average`,
        {
          contractName: input.contractName,
          operationName: input.operationName,
          gasUsed: input.gasUsed,
          rollingAvgGasUsageRatioPct: Math.round(rollingAvg * 100),
          gasUsageRatioPct: Math.round(gasUsageRatio * 100),
        },
        "smart-contract"
      );
    }

    return record;
  }

  function getRecords(): readonly GasUsageRecord[] {
    return [...records];
  }

  function clearRecords(): void {
    records.length = 0;
    rollingHistory.clear();
  }

  return {
    recordExecution,
    getRecords,
    getRollingAverage,
    clearRecords,
  };
}
