const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const minLevel: number = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase() as LogLevel] ?? LOG_LEVELS.info;

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < minLevel) return;
  const entry = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...data });
  process.stderr.write(`${entry}\n`);
}
