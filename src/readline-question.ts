// One EOF-safe wrapper for every `rl.question()` in the CLI.
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
// It deliberately does NOT close the interface: the caller created it and
// owns its lifetime (each call site has its own `finally { rl.close() }`).

import type { Interface } from "node:readline/promises";

export async function questionOrEmpty(rl: Interface, prompt: string): Promise<string> {
  // A question on an already-closed interface rejects with ERR_USE_AFTER_CLOSE
  // rather than hanging; map that to the same "no answer" outcome so a caller
  // never has to distinguish "closed before" from "closed during".
  if ((rl as { closed?: boolean }).closed === true) return "";
  const ac = new AbortController();
  const onClose = (): void => ac.abort();
  rl.once("close", onClose);
  try {
    return await rl.question(prompt, { signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) return "";
    throw err;
  } finally {
    rl.off("close", onClose);
  }
}
