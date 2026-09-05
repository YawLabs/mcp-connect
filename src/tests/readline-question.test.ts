import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { questionOrEmpty } from "../readline-question.js";

function makeRl(): { rl: ReturnType<typeof createInterface>; input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // never let the prompt echo back-pressure the test
  const rl = createInterface({ input, output });
  return { rl, input, output };
}

describe("questionOrEmpty", () => {
  it("returns the typed line when one arrives", async () => {
    const { rl, input } = makeRl();
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.write("y\n");
    await expect(pending).resolves.toBe("y");
    rl.close();
  });

  it("settles to an empty answer when the input hits EOF before any line", async () => {
    // The raw `rl.question()` promise stays pending forever here (Node 22:
    // the interface closes, the promise does not settle). The wrapper must
    // hand back "" so the caller's bare-Enter default applies.
    const { rl, input } = makeRl();
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.end();
    await expect(pending).resolves.toBe("");
    // `closed` is a runtime property of readline's Interface that the bundled
    // @types/node does not declare, hence the cast (same shape the helper uses).
    expect((rl as { closed?: boolean }).closed).toBe(true);
  });

  it("returns an empty answer immediately on an interface that is already closed", async () => {
    const { rl } = makeRl();
    rl.close();
    await expect(questionOrEmpty(rl, "Remove? [y/N] ")).resolves.toBe("");
  });

  it("does not leave a close listener behind after a normal answer", async () => {
    const { rl, input } = makeRl();
    const before = rl.listenerCount("close");
    const pending = questionOrEmpty(rl, "? ");
    input.write("ok\n");
    await pending;
    expect(rl.listenerCount("close")).toBe(before);
    rl.close();
  });
});
