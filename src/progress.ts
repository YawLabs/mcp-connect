import { log } from "./logger.js";

export type ProgressReporter = (message: string, progress?: number, total?: number) => void;

// Module-private: nothing outside this file names the type. It exists only
// to give createProgressReporter's parameter one place to index the callback
// shape out of, so exporting it would advertise an API no caller consumes.
interface ProgressSender {
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/** The `extra` a request handler receives, narrowed to the parts progress
 *  reporting reads. */
export type ProgressExtra =
  | { sendNotification?: ProgressSender["sendNotification"]; _meta?: Record<string, unknown> }
  | undefined;

/** Whether this request can actually receive progress: the client supplied a
 *  token AND there is a channel to send on.
 *
 *  Exported because the answer decides something OUTSIDE this file. Relaying
 *  an upstream tool's progress means handing the SDK an `onprogress`, which
 *  makes it stamp a progress token onto the upstream request -- so a caller
 *  that relays unconditionally changes the wire shape of every proxied call
 *  to collect notifications the reporter would then drop on the floor. Callers
 *  ask this first. Kept as the single source of the condition so it cannot
 *  drift from the reporter's own early return below, which now uses it. */
export function isProgressRequested(extra: ProgressExtra): boolean {
  const token = extra?._meta?.progressToken;
  return token !== undefined && token !== null && typeof extra?.sendNotification === "function";
}

// Returns a progress reporter for the current tool call. If the client
// supplied a progressToken in _meta, notifications flow back to the client
// as it progresses. If not, this is a no-op so callers never need to branch.
//
// The reporter is drop-in: callers can just describe *what* is happening
// (message-only), or additionally say *how far along* with an absolute
// progress/total pair. Message-only calls omit `total` so the client
// renders an indeterminate progress bar rather than a misleading percentage.
export function createProgressReporter(extra: ProgressExtra): ProgressReporter {
  if (!isProgressRequested(extra)) {
    return () => {};
  }
  // Non-null by isProgressRequested: it checked both of these.
  const token = extra?._meta?.progressToken as string | number;
  const send = extra?.sendNotification as ProgressSender["sendNotification"];

  // MCP requires progress to strictly increase per token. Two kinds of
  // calls share this one token: explicit milestones (caller supplies an
  // absolute `progress`, usually with `total`) and message-only sub-steps
  // (no numbers at all). The old scheme fed both through one integer
  // counter, so message-only calls inflated the counter past the caller's
  // absolute values and the monotonic clamp then re-emitted duplicates
  // and progress > total (a 300% bar on a plain dispatch). Instead:
  //   - message-only calls creep forward by a small epsilon and never
  //     carry a total (indeterminate), so they cannot consume the integer
  //     milestones the caller is about to report;
  //   - explicit calls emit the caller's value when it still moves the
  //     wire forward, otherwise lastEmitted + epsilon, and drop `total`
  //     when the nudged value would exceed it (never >100% on the wire).
  // A scalar suffices: `token` is captured once from this call's _meta and
  // never reassigned, so the reporter can only ever emit under that token.
  const EPSILON = 1e-3;
  let lastEmitted = -EPSILON; // so the first message-only call emits 0
  return (message, progress, total) => {
    let emitted: number;
    let emittedTotal: number | undefined;
    if (progress !== undefined) {
      emitted = progress > lastEmitted ? progress : lastEmitted + EPSILON;
      emittedTotal = total !== undefined && emitted <= total ? total : undefined;
    } else {
      emitted = lastEmitted + EPSILON;
      emittedTotal = undefined;
    }
    const params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    } = {
      progressToken: token,
      progress: emitted,
      message,
    };
    if (emittedTotal !== undefined) params.total = emittedTotal;
    lastEmitted = emitted;
    send({ method: "notifications/progress", params }).catch((err) => {
      log("warn", "Progress notification send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
