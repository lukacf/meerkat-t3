/**
 * This app executes through its native runtime. The registry keeps saved
 * configuration for other drivers readable as unavailable history.
 * @module provider/builtInDrivers
 */
import { MeerkatDriver, type MeerkatDriverEnv } from "./Drivers/MeerkatDriver.ts";
import type { ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import type { CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type { CursorDriverEnv } from "./Drivers/CursorDriver.ts";
import type { GrokDriverEnv } from "./Drivers/GrokDriver.ts";
import type { OpenCodeDriverEnv } from "./Drivers/OpenCodeDriver.ts";
import type { AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * The generic registry and its injected-driver tests retain the infrastructure
 * type union. These type-only imports do not register donor runtimes.
 */
export type BuiltInDriversEnv =
  | MeerkatDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv
  | AntigravityDriverEnv;

/** The only runtime this application may instantiate. */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  MeerkatDriver,
];
