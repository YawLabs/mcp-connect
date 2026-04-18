// Compliance-aware routing helpers. Phase 3 client-side filter keyed on
// the optional `complianceGrade` field on UpstreamServerConfig (see
// types.ts). The backend's /api/connect/config doesn't emit grades
// today — this code is forward-compatible: once the field starts
// flowing, the filter kicks in automatically; until then every server
// is "ungraded" and passes.
//
// Policy (matches README + activate tool description):
//   - Graded server:   must be ≥ the configured MCPH_MIN_COMPLIANCE.
//   - Ungraded server: always passes. We don't punish unknown.
//
// Exposed as pure helpers so server.ts and the unit tests share one
// implementation — no env reads in here, callers pass the parsed value.
import { log } from "./logger.js";

export type ComplianceGrade = "A" | "B" | "C" | "D" | "F";

const GRADE_ORDER: Record<ComplianceGrade, number> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  F: 0,
};

/**
 * Integer rank for a grade letter (A=4 … F=0). Case-insensitive. Returns
 * -1 for anything that isn't a recognized A-F letter so callers can
 * distinguish "ungraded" from "graded but low".
 */
export function gradeRank(grade: string | undefined | null): number {
  if (!grade) return -1;
  const up = grade.toUpperCase();
  if (up in GRADE_ORDER) return GRADE_ORDER[up as ComplianceGrade];
  return -1;
}

let invalidWarned = false;

/**
 * Parse the MCPH_MIN_COMPLIANCE env value into a canonical uppercase
 * grade, or null when the filter is disabled. Empty/undefined disables.
 * Invalid values log a single warning per process and are treated as
 * unset — we never fail closed on a typo in an env var.
 */
export function parseMinCompliance(raw: string | undefined): ComplianceGrade | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const up = trimmed.toUpperCase();
  if (up === "A" || up === "B" || up === "C" || up === "D" || up === "F") {
    return up;
  }
  if (!invalidWarned) {
    invalidWarned = true;
    log("warn", "Invalid MCPH_MIN_COMPLIANCE; filter disabled", { value: raw });
  }
  return null;
}

/**
 * Test hook — reset the one-shot warning latch so repeated tests on
 * invalid values still exercise the warn path. Not exported from
 * index.ts; internal to tests.
 */
export function __resetComplianceWarningLatch(): void {
  invalidWarned = false;
}

/**
 * True when `serverGrade` passes the minimum. Ungraded servers
 * (undefined / unknown letter) always pass, on the "don't punish
 * unknown" rule — most current deploys have no grade in the config
 * yet and we don't want to hide every server from every user.
 */
export function passesMinCompliance(serverGrade: string | undefined | null, min: ComplianceGrade | null): boolean {
  if (min === null) return true;
  const serverRank = gradeRank(serverGrade);
  if (serverRank < 0) return true; // ungraded → pass
  return serverRank >= gradeRank(min);
}
