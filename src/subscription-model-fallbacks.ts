const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Only model assignment fields, never transport/memory/plugin fallback policy. */
export function visitSubscriptionModelFallbacks(
  config: unknown,
  visit: (assignment: Record<string, unknown>) => void,
): void {
  const walk = (value: unknown, key: string, inMedia = false): void => {
    const row = object(value);
    if (!row) {
      if (Array.isArray(value))
        for (const child of value) walk(child, key, inMedia);
      return;
    }
    if (
      key === "model" ||
      key.endsWith("Model") ||
      (inMedia && ["image", "video", "music"].includes(key)) ||
      (key === "payload" &&
        (row.kind === "agentTurn" ||
          row.model !== undefined ||
          row.fallbacks !== undefined))
    )
      visit(row);
    for (const [childKey, child] of Object.entries(row))
      walk(child, childKey, key === "mediaModels");
  };
  const root = object(config);
  walk(root?.agents, "agents");
  walk(root?.cron, "cron");
}
