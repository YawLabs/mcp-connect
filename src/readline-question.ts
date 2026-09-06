// One EOF-safe, cancel-aware wrapper for every `rl.question()` in the CLI.
//
// `question()` from node:readline/promises never settles once its input
// closes: after Ctrl+D (or a piped stdin running dry) the interface reports
// `closed === true` and the promise stays pending forever (reproduced on Node
// v22.22.2). A yes/no prompt built directly on it therefore HANGS on EOF
// instead of taking the documented default -- `remove` never printed
// "Aborted", `install` never reached its collision default -- and the process
// ended via event-loop drain with status 0 rather than the documented 1.
//
// The wrapper aborts the pending question when the interface closes and hands
// the caller "" -- the same thing a bare Enter produces -- so every prompt's
// existing "empty answer means the safe default" branch handles EOF for free.
//
// Ctrl+C is NOT EOF. On a real terminal readline owns the keypress: with no
// `SIGINT` listener on the interface it closes the interface and raises no
// process-level signal, so a plain close handler would turn a cancel into the
// DEFAULT answer -- `install` answered its own collision prompt with "skip"
// and printed a success line at exit 0 when the user pressed Ctrl+C. The
// wrapper listens for the interface's `SIGINT` event and returns QUESTION_CANCELLED
// instead, a value no typed answer can equal, so callers map it to their
// cancel path (exit 130, the convention secrets-cmd's raw-mode reader set).
//
// It deliberately does NOT close the interface: the caller created it and
// owns its lifetime (each call site has its own `finally { rl.close() }`).

import type { Interface } from "node:readline/promises";

/** The answer questionOrEmpty returns for Ctrl+C at the prompt. A symbol, so
 *  no string the user could type -- including "" -- collides with it. */
export const QUESTION_CANCELLED: unique symbol = Symbol("yaw-mcp:question-cancelled");
export type QuestionCancelled = typeof QUESTION_CANCELLED;

export async function questionOrEmpty(rl: Interface, prompt: string): Promise<string | QuestionCancelled> {
  // A question on an already-closed interface rejects with ERR_USE_AFTER_CLOSE
  // rather than hanging; map that to the same "no answer" outcome so a caller
  // never has to distinguish "closed before" from "closed during".
  if ((rl as { closed?: boolean }).closed === true) return "";
  const ac = new AbortController();
  let cancelled = false;
  const onClose = (): void => ac.abort();
  const onSigint = (): void => {
    cancelled = true;
    ac.abort();
  };
  rl.once("close", onClose);
  rl.once("SIGINT", onSigint);
  try {
    return await rl.question(prompt, { signal: ac.signal });
  } catch (err) {
    if (cancelled) return QUESTION_CANCELLED;
    if (ac.signal.aborted) return "";
    throw err;
  } finally {
    rl.off("close", onClose);
    rl.off("SIGINT", onSigint);
  }
}
