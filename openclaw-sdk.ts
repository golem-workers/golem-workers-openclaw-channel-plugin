import type { z } from "zod";

export type OpenClawConfig = Record<string, unknown>;

type RuntimeIssue = {
  code?: string;
  expected?: unknown;
  input?: unknown;
  message?: string;
  path?: Array<string | number>;
};

type RuntimeParseSuccess<T> = {
  success: true;
  data: T;
};

type RuntimeParseFailure = {
  success: false;
  issues: RuntimeIssue[];
};

type RuntimeSchema<T> = {
  safeParse(value: unknown): RuntimeParseSuccess<T> | RuntimeParseFailure;
};

export type OpenClawPluginConfigSchema<T = unknown> = {
  schema: Record<string, unknown>;
  runtime: RuntimeSchema<T>;
  uiHints?: unknown;
};

export const emptyPluginConfigSchema: OpenClawPluginConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: true,
  },
  runtime: {
    safeParse(value) {
      return {
        success: true,
        data: value,
      };
    },
  },
};

type ZodLikeSchema<T> = z.ZodType<T> & {
  toJSONSchema?: (options?: {
    target?: string;
    unrepresentable?: "throw" | "any";
  }) => Record<string, unknown>;
};

function cloneRuntimeIssue(issue: unknown): RuntimeIssue {
  const record = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const rawPath = record.path;
  return {
    ...record,
    ...(Array.isArray(rawPath)
      ? {
          path: rawPath.filter(
            (segment): segment is string | number =>
              typeof segment === "string" || typeof segment === "number"
          ),
        }
      : {}),
  };
}

function safeParseRuntimeSchema<T>(
  schema: Pick<ZodLikeSchema<T>, "safeParse">,
  value: unknown
): RuntimeParseSuccess<T> | RuntimeParseFailure {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
  };
}

export function buildChannelConfigSchema<T>(
  schema: ZodLikeSchema<T>,
  options?: { uiHints?: unknown }
): OpenClawPluginConfigSchema<T> {
  if (typeof schema.toJSONSchema === "function") {
    return {
      schema: schema.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }),
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      runtime: {
        safeParse(value) {
          return safeParseRuntimeSchema(schema, value);
        },
      },
    };
  }

  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse(value) {
        return safeParseRuntimeSchema(schema, value);
      },
    },
  };
}

type ChannelAccountRef = {
  accountId?: string | null;
};

type ChannelToolContext = {
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
};

export type ChannelPlugin<TResolvedAccount = unknown> = {
  config?: {
    listAccountIds?: (cfg: OpenClawConfig) => string[];
    resolveAccount?: (cfg: OpenClawConfig, accountId?: string | null) => TResolvedAccount;
    inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    isEnabled?: (account: TResolvedAccount, cfg: OpenClawConfig) => boolean;
    isConfigured?: (account: TResolvedAccount) => boolean;
  };
  setup?: {
    applyAccountConfig?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      input: Record<string, unknown>;
    }) => OpenClawConfig;
    validateInput?: (input: unknown) => unknown;
  };
  status?: {
    buildAccountSnapshot?: (params: {
      cfg: OpenClawConfig;
      account: TResolvedAccount & ChannelAccountRef;
    }) => unknown;
  };
  gateway?: {
    startAccount?: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      account?: TResolvedAccount & ChannelAccountRef;
      abortSignal: AbortSignal;
    }) => Promise<unknown>;
    stopAccount?: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      account?: TResolvedAccount & ChannelAccountRef;
    }) => Promise<unknown>;
  };
  messaging?: {
    normalizeTarget?: (input: string) => string;
    parseExplicitTarget?: (params: { raw: string }) => unknown;
    inferTargetChatType?: (params: { to: string }) => unknown;
    formatTargetDisplay?: (params: { target: string; display?: string }) => string;
    resolveOutboundSessionRoute?: (params: {
      agentId: string;
      target: string;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => unknown;
    targetResolver?: {
      looksLikeId?: (raw: string, normalized?: string) => boolean;
      hint?: string;
      resolveTarget?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        input: string;
        normalized?: string;
        preferredKind?: string;
      }) => Promise<unknown> | unknown;
    };
  };
  resolver?: {
    resolveTargets?: (params: {
      inputs: string[];
      [key: string]: unknown;
    }) => Promise<unknown[]> | unknown[];
  };
  actions?: {
    describeMessageTool?: (params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) => unknown;
    supportsAction?: (params: { action: string }) => boolean;
    handleAction?: (params: {
      action: string;
      params: Record<string, unknown>;
      cfg: OpenClawConfig;
      accountId?: string | null;
      toolContext?: ChannelToolContext;
    }) => Promise<unknown> | unknown;
  };
  outbound?: {
    deliveryMode?: string;
    sendPayload?: (input: Record<string, unknown>) => Promise<unknown>;
    sendText?: (input: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => Promise<unknown>;
    sendMedia?: (input: Record<string, unknown>) => Promise<unknown>;
    requestFileDownload?: (input: Record<string, unknown>) => Promise<unknown>;
  };
  [key: string]: unknown;
};

export function createChannelPluginBase<TResolvedAccount>(
  params: ChannelPlugin<TResolvedAccount>
): ChannelPlugin<TResolvedAccount> {
  return params;
}

export type PluginRuntime = unknown;

export type OpenClawPluginApi = {
  runtime: PluginRuntime;
  registrationMode?: string;
  registerChannel(input: { plugin: unknown }): void;
};

export function defineChannelPluginEntry<TPlugin>(params: {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  setRuntime?: (runtime: PluginRuntime) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
}) {
  const { id, name, description, plugin, configSchema = emptyPluginConfigSchema, setRuntime, registerFull } = params;
  return {
    id,
    name,
    description,
    configSchema: typeof configSchema === "function" ? configSchema() : configSchema,
    register(api: OpenClawPluginApi) {
      setRuntime?.(api.runtime);
      api.registerChannel({ plugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerFull?.(api);
    },
    channelPlugin: plugin,
    ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
  };
}

export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}

function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}

export class ToolInputError extends Error {
  public readonly status = 400;

  public constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readParamRaw(params, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
  }
  return undefined;
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    required?: boolean;
    trim?: boolean;
    label?: string;
    allowEmpty?: boolean;
  } = {}
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  return value;
}

export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    required?: boolean;
    label?: string;
  } = {}
): string | undefined {
  const { required = false, label = key } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value) {
      return value;
    }
  }
  if (required) {
    throw new ToolInputError(`${label} required`);
  }
  return undefined;
}

type ToolResult<TDetails> = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  details: TDetails;
};

function textResult<TDetails>(text: string, details: TDetails): ToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details,
  };
}

export function jsonResult<TPayload>(payload: TPayload): ToolResult<TPayload> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}
