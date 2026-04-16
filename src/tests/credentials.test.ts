import { describe, expect, it } from "vitest";
import { detectMissingCredentials } from "../credentials.js";

describe("detectMissingCredentials", () => {
  it("returns empty for undefined or empty input", () => {
    expect(detectMissingCredentials(undefined)).toEqual([]);
    expect(detectMissingCredentials("")).toEqual([]);
  });

  it("matches 'X is required'", () => {
    expect(detectMissingCredentials("Error: GITHUB_TOKEN is required")).toEqual(["GITHUB_TOKEN"]);
  });

  it("matches 'missing env var X'", () => {
    expect(detectMissingCredentials("Missing env var OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
  });

  it("matches 'X is not set'", () => {
    expect(detectMissingCredentials("ANTHROPIC_API_KEY is not set")).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("dedupes across multiple matches", () => {
    expect(detectMissingCredentials("GITHUB_TOKEN is required. Please set GITHUB_TOKEN env variable.")).toEqual([
      "GITHUB_TOKEN",
    ]);
  });

  it("finds multiple distinct credentials", () => {
    const out = detectMissingCredentials("GITHUB_TOKEN is required. NPM_TOKEN must be set.");
    expect(out.sort()).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
  });

  it("ignores system env vars", () => {
    expect(detectMissingCredentials("PATH is not set")).toEqual([]);
    expect(detectMissingCredentials("HOME is required")).toEqual([]);
  });

  it("ignores lowercase names", () => {
    expect(detectMissingCredentials("token is required")).toEqual([]);
  });

  it("requires at least 3 characters to skip short false positives", () => {
    expect(detectMissingCredentials("X is required")).toEqual([]);
  });
});
