export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...data });
  process.stderr.write(entry + "\n");
}
