// Compliance-aware routing helpers. Phase 3 client-side filter keyed on
// the optional `complianceGrade` field on UpstreamServerConfig (see
// types.ts). The backend's /api/connect/config doesn't emit grades
// today -- this code is forward-compatible: once the field starts
// flowing, the filter kicks in automatically; until then every server
// is "ungraded" and passes.
//
// Policy (matches README + activate tool description):
//   - Graded server:   must be >= the configured MCPH_MIN_COMPLIANCE.
//   - Ungraded server: always passes. We don't punish absent.
//   - Server with an unrecognized grade string ("Z", "AAA", typos): when
//     a min is set, fail closed with a one-shot warn. We treat a present-
//     but-garbled grade as a signal of misconfiguration or tampering, not
//     as a synonym for "ungraded".
//
// Exposed as pure helpers so server.ts and the unit tests share one
// implementation -- no env reads in here, callers pass the parsed value.
import { log } from "./logger.js";

export type ComplianceGrade = "A" | "B" | "C" | "D" | "F";

const GRADE_ORDER: Record<ComplianceGrade, number> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  F: 0,
};

type GradeClassification =
  | { kind: "ungraded" }
  | { kind: "unrecognized"; raw: string }
  | { kind: "graded"; rank: number };

function classifyGrade(grade: string | undefined | null): GradeClassification {
  if (grade === undefined || grade === null) return { kind: "ungraded" };
  const trimmed = grade.trim();
  if (trimmed === "") return { kind: "ungraded" };
  const up = trimmed.toUpperCase();
  if (up in GRADE_ORDER) return { kind: "graded", rank: GRADE_ORDER[up as ComplianceGrade] };
  return { kind: "unrecognized", raw: grade };
}

/**
 * Integer rank for a grade letter (A=4 ... F=0). Case-insensitive.
 * Returns -1 for ungraded AND unrecognized; callers wanting the three-
 * way distinction (ungraded vs garbage) should use passesMinCompliance.
 */
export function gradeRank(grade: string | undefined | null): number {
  const c = classifyGrade(grade);
  return c.kind === "graded" ? c.rank : -1;
}

let invalidWarned = false;
const unrecognizedServerWarned = new Set<string>();

/**
 * Parse the MCPH_MIN_COMPLIANCE env value into a canonical uppercase
 * grade, or null when the filter is disabled. Empty/undefined disables.
 * Invalid values log a single warning per process and are treated as
 * unset -- we never fail closed on a typo in an env var.
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
 * Test hook -- reset the one-shot warning latches so repeated tests on
 * invalid values still exercise the warn path. Not exported from
 * index.ts; internal to tests.
 */
export function __resetComplianceWarningLatch(): void {
  invalidWarned = false;
  unrecognizedServerWarned.clear();
}

/**
 * True when `serverGrade` passes the minimum. Ungraded (absent / empty /
 * whitespace) servers pass when a min is set ("don't punish absent" --
 * most current deploys have no grade yet). Unrecognized grade strings
 * fail closed when a min is set, with a one-shot warn naming the value;
 * a garbled grade should not be treated as a free pass.
 */
export function passesMinCompliance(serverGrade: string | undefined | null, min: ComplianceGrade | null): boolean {
  if (min === null) return true;
  const c = classifyGrade(serverGrade);
  if (c.kind === "ungraded") return true;
  if (c.kind === "unrecognized") {
    if (!unrecognizedServerWarned.has(c.raw)) {
      unrecognizedServerWarned.add(c.raw);
      log("warn", "Unrecognized server compliance grade; failing closed under MCPH_MIN_COMPLIANCE", {
        grade: c.raw,
        min,
      });
    }
    return false;
  }
  return c.rank >= gradeRank(min);
}
