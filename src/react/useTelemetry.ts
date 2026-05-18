"use client";

/**
 * @file useTelemetry.ts
 * @description Primary React hook for @devright/pi-agent-telemetry.
 *
 * Exposes the logger API (`log.debug`, `log.info`, `log.warn`, `log.error`,
 * `log.fatal`) and real-time health metrics to any component within the
 * TelemetryProvider tree.
 *
 * @example
 * ```tsx
 * function PaymentButton() {
 *   const { log, health, flush } = useTelemetry();
 *
 *   const handlePress = async () => {
 *     log.info("Payment button pressed", { screen: "checkout" });
 *     try {
 *       await submitPayment();
 *     } catch (err) {
 *       log.error("Payment failed", err as Error, { screen: "checkout" });
 *     }
 *   };
 *
 *   return <button onClick={handlePress}>Pay with Pi</button>;
 * }
 * ```
 */

import { useCallback, useEffect, useState } from "react";
import { useTelemetryContext } from "./TelemetryProvider.js";
import type {
  UseTelemetryReturn,
  TelemetryLogger,
  HealthMetrics,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the telemetry logger and real-time health metrics for the current
 * component. Must be called within a `<TelemetryProvider>` tree.
 *
 * @returns An object with `log`, `health`, `isInitialized`, and `flush`.
 *
 * @throws {Error} If called outside of a TelemetryProvider.
 */
export function useTelemetry(): UseTelemetryReturn {
  const { engine, isInitialized } = useTelemetryContext();

  // -------------------------------------------------------------------------
  // Health Metrics — polled from the engine at a 5-second interval
  // -------------------------------------------------------------------------

  const [health, setHealth] = useState<HealthMetrics>({
    memory: null,
    battery: null,
    apiLatencyMs: null,
  });

  useEffect(() => {
    // Initial read
    setHealth({
      memory: engine.getMemorySnapshot(),
      battery: engine.getBatteryStatus(),
      apiLatencyMs: null,
    });

    // Periodic refresh
    const intervalId = setInterval(() => {
      setHealth({
        memory: engine.getMemorySnapshot(),
        battery: engine.getBatteryStatus(),
        apiLatencyMs: null,
      });
    }, 5_000);

    return () => clearInterval(intervalId);
  }, [engine]);

  // -------------------------------------------------------------------------
  // Logger
  // -------------------------------------------------------------------------

  const log: TelemetryLogger = {
    debug: useCallback(
      (
        message: string,
        payload: Record<string, string | number | boolean | null> = {}
      ) => {
        void engine.debug(message, payload);
      },
      [engine]
    ),

    info: useCallback(
      (
        message: string,
        payload: Record<string, string | number | boolean | null> = {}
      ) => {
        void engine.info(message, payload);
      },
      [engine]
    ),

    warn: useCallback(
      (
        message: string,
        payload: Record<string, string | number | boolean | null> = {}
      ) => {
        void engine.warn(message, payload);
      },
      [engine]
    ),

    error: useCallback(
      (
        message: string,
        error?: Error,
        payload: Record<string, string | number | boolean | null> = {}
      ) => {
        void engine.error(message, error, payload);
      },
      [engine]
    ),

    fatal: useCallback(
      (
        message: string,
        error?: Error,
        payload: Record<string, string | number | boolean | null> = {}
      ) => {
        void engine.fatal(message, error, payload);
      },
      [engine]
    ),
  };

  // -------------------------------------------------------------------------
  // Manual Flush
  // -------------------------------------------------------------------------

  const flush = useCallback(async (): Promise<void> => {
    await engine.flush();
  }, [engine]);

  return {
    log,
    health,
    isInitialized,
    flush,
  };
}
