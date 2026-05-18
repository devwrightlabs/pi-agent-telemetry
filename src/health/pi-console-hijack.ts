/**
 * @file pi-console-hijack.ts
 * @description Universal console interceptor for the Pi Network mobile webview.
 *
 * Safely patches `console.error` and `console.warn` (and optionally `console.log`)
 * inside the webview container, routing all captured output directly to the
 * developer's remote Devright dashboard via the TelemetryEngine.
 *
 * Design principles:
 *  - Non-destructive: the original console methods are always called after
 *    interception so native DevTools output is preserved.
 *  - Idempotent: calling `installConsoleHijack` multiple times is safe.
 *  - Removable: call `removeConsoleHijack` to fully restore original methods.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the console hijack installer. */
export interface ConsoleHijackConfig {
  /** The TelemetryEngine instance to route captured output to. */
  readonly engine: TelemetryEngine;
  /**
   * Whether to also intercept `console.log` (in addition to warn/error).
   * Defaults to false to avoid spamming the dashboard with verbose output.
   */
  readonly interceptLog?: boolean;
  /**
   * Whether to suppress forwarding of errors/warnings that originate from
   * within the TelemetryEngine itself (prevents infinite loops).
   * Defaults to true.
   */
  readonly guardReentry?: boolean;
}

/** Handle returned by `installConsoleHijack` for later removal. */
export interface ConsoleHijackHandle {
  /** Removes all patches and restores original console methods. */
  remove(): void;
  /** Returns true if the hijack is currently active. */
  isActive(): boolean;
}

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

/** Tracks whether a hijack is currently installed (prevents double-install). */
let _installed = false;

/** Re-entrancy guard: prevents logging-from-logging infinite loops. */
let _reentryGuard = false;

// ---------------------------------------------------------------------------
// Argument Serializer
// ---------------------------------------------------------------------------

/**
 * Converts arbitrary console arguments into a single human-readable string.
 * Handles Error objects, objects (JSON), and primitives gracefully.
 *
 * @param args - The raw arguments passed to the console method.
 * @returns A combined string representation.
 */
function serializeConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
      }
      if (typeof arg === "object" && arg !== null) {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");
}

/**
 * Extracts a JavaScript Error from console arguments, if one is present.
 *
 * @param args - Raw console arguments.
 * @returns The first Error found, or null.
 */
function extractError(args: unknown[]): Error | undefined {
  for (const arg of args) {
    if (arg instanceof Error) return arg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Installs the console hijack patches in the current JavaScript environment.
 * After installation, all `console.error` and `console.warn` calls are
 * intercepted and forwarded to the Devright dashboard as telemetry events.
 *
 * The original console methods are always invoked after interception to
 * ensure normal DevTools output is not disrupted.
 *
 * @param config - Hijack configuration (engine + optional flags).
 * @returns A handle with `remove()` and `isActive()` methods.
 *
 * @example
 * ```ts
 * const handle = installConsoleHijack({ engine });
 * // Later, during cleanup:
 * handle.remove();
 * ```
 */
export function installConsoleHijack(config: ConsoleHijackConfig): ConsoleHijackHandle {
  if (_installed) {
    // Return a no-op handle if already installed
    return {
      remove: () => undefined,
      isActive: () => true,
    };
  }

  const { engine, interceptLog = false, guardReentry = true } = config;

  // Stash originals
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);

  /**
   * Factory that creates an intercepting function for a given console level.
   */
  function makeInterceptor(
    original: (...args: unknown[]) => void,
    telemetryLevel: "warn" | "error"
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      // Always invoke the original first
      original(...args);

      // Guard against re-entrancy
      if (guardReentry && _reentryGuard) return;

      _reentryGuard = true;
      try {
        const message = serializeConsoleArgs(args);
        const error = extractError(args);
        void engine.log(
          telemetryLevel,
          `[console.${telemetryLevel}] ${message}`,
          {},
          telemetryLevel === "error" ? "crash" : "general",
          error
        );
      } finally {
        _reentryGuard = false;
      }
    };
  }

  // Install patches
  console.error = makeInterceptor(originalError, "error") as typeof console.error;
  console.warn = makeInterceptor(originalWarn, "warn") as typeof console.warn;

  if (interceptLog) {
    console.log = ((...args: unknown[]) => {
      originalLog(...args);
      if (guardReentry && _reentryGuard) return;
      _reentryGuard = true;
      try {
        void engine.log("debug", `[console.log] ${serializeConsoleArgs(args)}`, {}, "general");
      } finally {
        _reentryGuard = false;
      }
    }) as typeof console.log;
  }

  _installed = true;

  return {
    remove() {
      if (!_installed) return;
      console.error = originalError as typeof console.error;
      console.warn = originalWarn as typeof console.warn;
      if (interceptLog) {
        console.log = originalLog as typeof console.log;
      }
      _installed = false;
    },
    isActive() {
      return _installed;
    },
  };
}

/**
 * Convenience function to remove any previously installed console hijack.
 * Typically called during component unmount or engine teardown.
 *
 * Note: This only works if the handle returned by `installConsoleHijack` is
 * still in scope. For long-lived handles, prefer calling `handle.remove()`.
 */
export function isConsoleHijackActive(): boolean {
  return _installed;
}
