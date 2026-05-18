"use client";

/**
 * @file TelemetryProvider.tsx
 * @description React Context Provider for @devright/pi-agent-telemetry.
 *
 * Initializes a TelemetryEngine singleton, mounts all health monitoring
 * subsystems, and binds the global unhandled error listeners. The engine
 * instance and its logger are exposed to descendant components via Context.
 *
 * Usage:
 * ```tsx
 * import { TelemetryProvider } from "@devright/pi-agent-telemetry/react";
 *
 * function App() {
 *   return (
 *     <TelemetryProvider config={{ endpointUrl: "...", apiKey: "...", appVersion: "1.0.0" }}>
 *       <YourApp />
 *     </TelemetryProvider>
 *   );
 * }
 * ```
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { TelemetryEngine } from "../core/TelemetryEngine.js";
import { installConsoleHijack } from "../health/pi-console-hijack.js";
import { startPredictiveOracle } from "../health/pi-predictive-oracle.js";
import { startBatteryDrainMonitor } from "../health/pi-battery-drain-monitor.js";
import { installNetworkHeatmap } from "../health/pi-network-heatmap.js";

import type { TelemetryProviderProps } from "../types/telemetry.js";
import type { ConsoleHijackHandle } from "../health/pi-console-hijack.js";
import type { PredictiveOracleHandle } from "../health/pi-predictive-oracle.js";
import type { BatteryDrainMonitorHandle } from "../health/pi-battery-drain-monitor.js";
import type { NetworkHeatmapHandle } from "../health/pi-network-heatmap.js";

// ---------------------------------------------------------------------------
// Context Shape
// ---------------------------------------------------------------------------

/** The value stored in the TelemetryContext. */
export interface TelemetryContextValue {
  readonly engine: TelemetryEngine;
  readonly isInitialized: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The React context holding the TelemetryEngine. */
export const TelemetryContext = createContext<TelemetryContextValue | null>(null);
TelemetryContext.displayName = "DevrightTelemetryContext";

/**
 * Low-level hook that returns the raw TelemetryContextValue.
 * Prefer `useTelemetry()` for the full consumer API.
 *
 * @throws {Error} If called outside of a TelemetryProvider tree.
 */
export function useTelemetryContext(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (ctx === null) {
    throw new Error(
      "[pi-agent-telemetry] useTelemetryContext() must be called inside a <TelemetryProvider>."
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Initializes and provides the TelemetryEngine to the React component tree.
 * Mount this once at the root of your application, ideally wrapping your
 * entire component tree.
 *
 * Subsystems initialized automatically on mount:
 *   - Console hijack (error/warn interception)
 *   - Predictive memory oracle
 *   - Battery drain monitor
 *   - Network heatmap interceptor
 *   - Global `unhandledrejection` and `error` listeners
 *
 * All subsystems are cleaned up on unmount via the returned Effect teardown.
 *
 * **Important:** The `config` prop is read once on mount. To prevent accidental
 * re-initialization, pass a stable reference (e.g., a module-level constant or
 * a `useMemo`-wrapped value). Config changes after mount are intentionally ignored.
 *
 * @param props - Provider props including the TelemetryEngineConfig.
 */
export function TelemetryProvider({
  config,
  children,
}: TelemetryProviderProps): React.ReactElement {
  // Use a ref so the engine identity is stable across re-renders
  const engineRef = useRef<TelemetryEngine | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Cleanup refs for all subsystems
  const consoleHandleRef = useRef<ConsoleHijackHandle | null>(null);
  const oracleHandleRef = useRef<PredictiveOracleHandle | null>(null);
  const batteryHandleRef = useRef<BatteryDrainMonitorHandle | null>(null);
  const heatmapHandleRef = useRef<NetworkHeatmapHandle | null>(null);

  useEffect(() => {
    // Create engine (lazily, only once)
    const engine = new TelemetryEngine(config);
    engineRef.current = engine;

    // -----------------------------------------------------------------------
    // 1. Console hijack
    // -----------------------------------------------------------------------
    consoleHandleRef.current = installConsoleHijack({ engine });

    // -----------------------------------------------------------------------
    // 2. Predictive memory oracle
    // -----------------------------------------------------------------------
    oracleHandleRef.current = startPredictiveOracle({ engine });

    // -----------------------------------------------------------------------
    // 3. Battery drain monitor (async — no await in useEffect)
    // -----------------------------------------------------------------------
    void startBatteryDrainMonitor({ engine }).then((handle) => {
      batteryHandleRef.current = handle;
    });

    // -----------------------------------------------------------------------
    // 4. Network heatmap
    // -----------------------------------------------------------------------
    heatmapHandleRef.current = installNetworkHeatmap({ engine });

    // -----------------------------------------------------------------------
    // 5. Global error listeners
    // -----------------------------------------------------------------------
    const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
      const err =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      void engine.log(
        "error",
        `[GlobalError] Unhandled Promise rejection: ${err.message}`,
        { type: "unhandledrejection" },
        "crash",
        err
      );
    };

    const handleWindowError = (event: ErrorEvent): void => {
      const err = event.error instanceof Error
        ? event.error
        : new Error(event.message);
      void engine.log(
        "fatal",
        `[GlobalError] Uncaught exception: ${err.message}`,
        {
          filename: event.filename ?? "unknown",
          lineno: event.lineno,
          colno: event.colno,
        },
        "crash",
        err
      );
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleWindowError);

    // -----------------------------------------------------------------------
    // 6. Flush on page visibility change (app backgrounded)
    // -----------------------------------------------------------------------
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        void engine.flush();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    setIsInitialized(true);

    // Log initialization
    void engine.log(
      "info",
      "[TelemetryProvider] Devright telemetry engine initialized",
      { appVersion: config.appVersion },
      "general"
    );

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------
    return () => {
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("error", handleWindowError);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      consoleHandleRef.current?.remove();
      oracleHandleRef.current?.stop();
      batteryHandleRef.current?.stop();
      heatmapHandleRef.current?.remove();

      void engine.destroy();
      engineRef.current = null;
      setIsInitialized(false);
    };
    // config is expected to be stable (pass a memoized object)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // During SSR or before initialization, provide a disabled engine stub
  if (engineRef.current === null) {
    // Render a temporary disabled engine to avoid null checks downstream
    const placeholderEngine = new TelemetryEngine({ ...config, disabled: true });
    return (
      <TelemetryContext.Provider
        value={{ engine: placeholderEngine, isInitialized: false }}
      >
        {children}
      </TelemetryContext.Provider>
    );
  }

  return (
    <TelemetryContext.Provider
      value={{ engine: engineRef.current, isInitialized }}
    >
      {children}
    </TelemetryContext.Provider>
  );
}
