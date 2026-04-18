import { beforeEach, describe, expect, it } from "vitest";
import { __resetComplianceWarningLatch, gradeRank, parseMinCompliance, passesMinCompliance } from "../compliance.js";

describe("gradeRank", () => {
  it("maps A-F to descending ranks", () => {
    expect(gradeRank("A")).toBe(4);
    expect(gradeRank("B")).toBe(3);
    expect(gradeRank("C")).toBe(2);
    expect(gradeRank("D")).toBe(1);
    expect(gradeRank("F")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(gradeRank("a")).toBe(4);
    expect(gradeRank("f")).toBe(0);
  });

  it("returns -1 for unknown or missing grades (ungraded)", () => {
    expect(gradeRank(undefined)).toBe(-1);
    expect(gradeRank(null)).toBe(-1);
    expect(gradeRank("")).toBe(-1);
    expect(gradeRank("Z")).toBe(-1);
    expect(gradeRank("E")).toBe(-1); // no E grade in A-F scale
  });
});

describe("parseMinCompliance", () => {
  beforeEach(() => {
    // One-shot warning latch resets between tests so each invalid-value
    // case exercises the warn path rather than silently passing on the
    // second run.
    __resetComplianceWarningLatch();
  });

  it("returns null when the env var is unset", () => {
    expect(parseMinCompliance(undefined)).toBeNull();
  });

  it("returns null when the env var is empty / whitespace", () => {
    expect(parseMinCompliance("")).toBeNull();
    expect(parseMinCompliance("   ")).toBeNull();
  });

  it("accepts every valid A-F grade", () => {
    expect(parseMinCompliance("A")).toBe("A");
    expect(parseMinCompliance("B")).toBe("B");
    expect(parseMinCompliance("C")).toBe("C");
    expect(parseMinCompliance("D")).toBe("D");
    expect(parseMinCompliance("F")).toBe("F");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseMinCompliance("a")).toBe("A");
    expect(parseMinCompliance(" b ")).toBe("B");
    expect(parseMinCompliance("c\n")).toBe("C");
  });

  it("returns null for invalid values (filter disabled, warning logged)", () => {
    expect(parseMinCompliance("Z")).toBeNull();
    expect(parseMinCompliance("AA")).toBeNull();
    expect(parseMinCompliance("9")).toBeNull();
    expect(parseMinCompliance("grade-a")).toBeNull();
  });
});

describe("passesMinCompliance", () => {
  it("returns true for every grade when the filter is null (disabled)", () => {
    expect(passesMinCompliance("A", null)).toBe(true);
    expect(passesMinCompliance("F", null)).toBe(true);
    expect(passesMinCompliance(undefined, null)).toBe(true);
    expect(passesMinCompliance("unknown", null)).toBe(true);
  });

  it("returns true for ungraded servers regardless of min (don't punish unknown)", () => {
    expect(passesMinCompliance(undefined, "A")).toBe(true);
    expect(passesMinCompliance(null, "B")).toBe(true);
    expect(passesMinCompliance("", "F")).toBe(true);
    expect(passesMinCompliance("Z", "A")).toBe(true); // unknown letter treated as ungraded
  });

  it("passes when grade equals min (A passes min=A)", () => {
    expect(passesMinCompliance("A", "A")).toBe(true);
  });

  it("passes when grade exceeds min (A passes min=B)", () => {
    expect(passesMinCompliance("A", "B")).toBe(true);
    expect(passesMinCompliance("B", "C")).toBe(true);
    expect(passesMinCompliance("C", "D")).toBe(true);
    expect(passesMinCompliance("D", "F")).toBe(true);
  });

  it("fails when grade is below min (D fails min=B)", () => {
    expect(passesMinCompliance("D", "B")).toBe(false);
    expect(passesMinCompliance("C", "B")).toBe(false);
    expect(passesMinCompliance("F", "D")).toBe(false);
  });

  it("F fails every non-F minimum, passes only min=F", () => {
    expect(passesMinCompliance("F", "A")).toBe(false);
    expect(passesMinCompliance("F", "B")).toBe(false);
    expect(passesMinCompliance("F", "C")).toBe(false);
    expect(passesMinCompliance("F", "D")).toBe(false);
    expect(passesMinCompliance("F", "F")).toBe(true);
  });

  it("is case-insensitive on the server-reported grade", () => {
    expect(passesMinCompliance("a", "B")).toBe(true);
    expect(passesMinCompliance("d", "B")).toBe(false);
  });
});
