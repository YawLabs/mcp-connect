import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsoncComments } from "../jsonc.js";

describe("stripJsoncComments", () => {
  it("leaves plain JSON untouched", () => {
    const src = '{"a":1,"b":"c"}';
    expect(stripJsoncComments(src)).toBe(src);
  });

  it("strips // line comments", () => {
    const src = '{\n  "a": 1 // inline\n}';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("strips /* block */ comments", () => {
    const src = '{ /* leading */ "a": 1 /* trailing */ }';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("strips multi-line block comments", () => {
    const src = '{\n/*\n  multi\n  line\n*/\n"a": 1\n}';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("preserves newlines inside block comments so line numbers in parse errors stay accurate", () => {
    const src = "/*\n\n\n*/\n{not valid json}";
    const stripped = stripJsoncComments(src);
    // Block comment is now whitespace, but the four newlines survive.
    expect((stripped.match(/\n/g) ?? []).length).toBe(4);
  });

  it("preserves // inside strings", () => {
    const src = '{"url": "https://mcp.hosting"}';
    expect(parseJsonc(src)).toEqual({ url: "https://mcp.hosting" });
  });

  it("preserves /* inside strings", () => {
    const src = '{"s": "a /* b */ c"}';
    expect(parseJsonc(src)).toEqual({ s: "a /* b */ c" });
  });

  it("honors escaped quote inside string so //-after-escape is not scanned as a comment", () => {
    // String: `he said "hi //"`. After that closes, // is a real comment.
    const src = '{"msg": "he said \\"hi //\\"" // real comment\n}';
    expect(parseJsonc(src)).toEqual({ msg: 'he said "hi //"' });
  });

  it("honors // and /* inside single-quoted strings too (defensive, even though JSON disallows)", () => {
    // parseJsonc will fail on single-quoted strings at JSON.parse time,
    // but stripJsoncComments must not treat // inside them as comments,
    // else an error-path fallback that re-emits the source would be wrong.
    const src = "{'s': 'a // b'}";
    expect(stripJsoncComments(src)).toBe(src);
  });

  it("handles token on same line as // comment", () => {
    const src = '{"token": "mcp_pat_abc" // my token\n}';
    expect(parseJsonc(src)).toEqual({ token: "mcp_pat_abc" });
  });

  it("is robust to a /* that never closes — swallows to EOF rather than throwing mid-strip", () => {
    const src = '{"a": 1} /* unclosed';
    // Stripping succeeds; JSON.parse sees just `{"a": 1}` and returns ok.
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("parseJsonc still throws SyntaxError on invalid JSON (not silently empty)", () => {
    expect(() => parseJsonc("{ not valid }")).toThrow(SyntaxError);
  });

  it("parseJsonc strips a leading UTF-8 BOM (Notepad-saved configs)", () => {
    const src = `﻿${JSON.stringify({ a: 1 })}`;
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("parseJsonc strips BOM before processing comments", () => {
    const src = `﻿// header\n{"a": 1}`;
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });
});
