import type { ConnectionHealth } from "./types.js";

// Health-aware ranking penalty. Takes a raw ranker score and scales it
// by a [0.5, 1.0] factor derived from observed reliability so dispatch
// prefers servers that have been working in this session over servers
// that have been flaking. Pure client-side — no backend dependency.
//
// We only ever *shrink* the score; we never boost above the raw value.
// The idea is "all else equal, prefer the one that works," not "a very
// healthy obscure match beats a marginally healthy exact match."
//
// Thresholds are tuned by intuition — when we have usage data the values
// should be revisited. Current defaults:
//   - Need ≥3 observations before error rate matters (noise floor).
//   - 0% errors  → factor 1.00 (no penalty)
//   - 30% errors → factor 0.70
//   - 50%+ errors → factor 0.50 (floor — never drop below)
//   - Activation failure within ACTIVATION_FAILURE_TTL_MS → factor 0.50
export const ACTIVATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const OBSERVATION_FLOOR = 3;
const MIN_FACTOR = 0.5;

export interface ActivationFailure {
  at: number;
  message: string;
}

export function errorRateFactor(health: ConnectionHealth | undefined): number {
  if (!health) return 1.0;
  if (health.totalCalls < OBSERVATION_FLOOR) return 1.0;
  const rate = health.errorCount / health.totalCalls;
  const factor = 1 - rate;
  return Math.max(MIN_FACTOR, factor);
}

export function activationFailureFactor(failure: ActivationFailure | undefined, now: number = Date.now()): number {
  if (!failure) return 1.0;
  if (now - failure.at > ACTIVATION_FAILURE_TTL_MS) return 1.0;
  return MIN_FACTOR;
}

// Combine signals by taking the strictest penalty — worst observed
// reliability wins, because both signals are evidence of real failure.
export function healthFactor(
  health: ConnectionHealth | undefined,
  activationFailure: ActivationFailure | undefined,
  now: number = Date.now(),
): number {
  return Math.min(errorRateFactor(health), activationFailureFactor(activationFailure, now));
}
