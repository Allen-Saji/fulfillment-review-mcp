export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(
  minimumLevel: LogLevel,
  write: (line: string) => void = (line) => {
    console.log(line);
  },
): Logger {
  function log(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (weights[level] < weights[minimumLevel]) {
      return;
    }
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...definedFields,
      }),
    );
  }

  return {
    debug: (event, fields) => {
      log("debug", event, fields);
    },
    info: (event, fields) => {
      log("info", event, fields);
    },
    warn: (event, fields) => {
      log("warn", event, fields);
    },
    error: (event, fields) => {
      log("error", event, fields);
    },
  };
}
