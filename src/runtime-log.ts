type LogLevel = "error" | "info" | "warn";

export function logRuntimeEvent(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {}
): void {
  const logger =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  logger(`[relay-channel-plugin] ${message}`, fields);
}
