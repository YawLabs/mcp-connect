// What tells a serving yaw-mcp that it is time to stop.
//
// runServer used to register SIGTERM and SIGINT and nothing else, which is
// a POSIX-shaped assumption. On Windows neither of those is delivered the
// way a parent process actually ends a child: an MCP client closes the
// broker down by closing the pipe it holds on the child's stdin. Nothing
// was listening for that, so `shutdown()` never ran there -- and every
// upstream server the broker had spawned (up to YAW_MCP_SERVER_CAP, six by
// default) was left for the OS to reap instead of being torn down. Across a
// day of opening and closing a client, that is orphaned MCP servers piling
// up on the machine this project is developed on.
//
// The SDK does not cover this for us. StdioServerTransport.start() attaches
// exactly two stdin listeners, 'data' and 'error' (see
// @modelcontextprotocol/sdk/dist/esm/server/stdio.js); it has no 'end' or
// 'close' listener, so its own `onclose` fires only when something calls
// transport.close() explicitly. On EOF nothing does. Hooking stdin here is
// therefore the fix, not a belt-and-braces addition to an SDK path that
// already works.

/** Structural minimum of an EventEmitter this module attaches to. Kept
 *  deliberately loose (rather than Pick<NodeJS.Process, "on">) because
 *  `process.on` and `Socket.on` are both heavily overloaded, and narrowing
 *  to the exact signal/event unions makes them stop being assignable. */
export interface ShutdownEventTarget {
  on(event: string, listener: () => void): unknown;
}

/** Signals that mean "stop" on POSIX. Unchanged behaviour -- listed here so
 *  the whole trigger set is readable in one place. */
export const SIGNAL_SHUTDOWN_EVENTS = ["SIGTERM", "SIGINT"] as const;

/** stdin events that mean "the client is gone".
 *
 *  'end' is the clean case: the peer closed the pipe and the readable side
 *  reached EOF. 'close' covers the stream being destroyed without a clean
 *  end (an errored or forcibly-torn-down pipe), which is the shape a killed
 *  parent leaves behind. Registering both is free because the shutdown
 *  callback is expected to be idempotent -- see registerShutdownTriggers. */
export const STDIN_SHUTDOWN_EVENTS = ["end", "close"] as const;

export interface ShutdownTargets {
  /** Usually the real `process`. */
  proc: ShutdownEventTarget;
  /** Usually `process.stdin`. */
  stdin: ShutdownEventTarget;
}

/**
 * Wire every "time to stop" event to one shutdown callback.
 *
 * `shutdown` MUST be idempotent: up to four of these can fire for a single
 * teardown (a signal, then 'end', then 'close'), and a killed client can
 * deliver both stdin events back to back. runServer's `shuttingDown` latch
 * is what makes that safe; this module deliberately does not add a second
 * latch of its own, so there is exactly one place that decides what
 * "already shutting down" means.
 *
 * Deliberately does NOT call stdin.resume(). Resuming puts the stream in
 * flowing mode, and until StdioServerTransport attaches its own 'data'
 * listener there is no consumer -- so anything the client had already
 * written, including its `initialize` request, would be read out of the
 * pipe and dropped on the floor. Attaching listeners for 'end' and 'close'
 * alone does not start flow, so this is inert until the transport starts
 * reading, at which point EOF is delivered normally. That ordering is the
 * whole reason this is safe to call before server.start().
 */
export function registerShutdownTriggers(shutdown: () => void, targets: ShutdownTargets): void {
  for (const signal of SIGNAL_SHUTDOWN_EVENTS) {
    targets.proc.on(signal, shutdown);
  }
  for (const event of STDIN_SHUTDOWN_EVENTS) {
    targets.stdin.on(event, shutdown);
  }
}
