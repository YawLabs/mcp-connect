import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { QUESTION_CANCELLED, questionOrEmpty } from "../readline-question.js";

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
    const beforeSigint = rl.listenerCount("SIGINT");
    const pending = questionOrEmpty(rl, "? ");
    input.write("ok\n");
    await pending;
    expect(rl.listenerCount("close")).toBe(before);
    expect(rl.listenerCount("SIGINT")).toBe(beforeSigint);
    rl.close();
  });

  it("returns QUESTION_CANCELLED, not the empty default, on Ctrl+C at the prompt", async () => {
    // On a real terminal readline owns the keypress: with no SIGINT listener
    // on the interface it closes the interface and raises no process signal,
    // so a close-only handler turned a cancel into the DEFAULT answer --
    // `install` answered its own collision prompt with "skip" and printed a
    // success line at exit 0. terminal:true so the keypress path is live, as
    // it is on a TTY; ETX (code 3) is the byte the terminal delivers for
    // Ctrl+C, built from the code so no control byte sits in this source.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = createInterface({ input, output, terminal: true });
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.write(String.fromCharCode(3));
    await expect(pending).resolves.toBe(QUESTION_CANCELLED);
    rl.close();
  });

  it("still reads EOF as the empty default when no Ctrl+C was pressed", async () => {
    // Positive control for the cancel case: closing the input WITHOUT the
    // keypress must keep resolving "" -- EOF is the safe default, not a cancel.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = createInterface({ input, output, terminal: true });
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.end();
    await expect(pending).resolves.toBe("");
  });
});
