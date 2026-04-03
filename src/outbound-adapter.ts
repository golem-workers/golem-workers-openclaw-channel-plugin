import type { RelayResolvedTarget } from "../api.js";
import { RelayAccountRuntime } from "./account-runtime.js";

export class RelayOutboundAdapter {
  public constructor(private readonly runtime: RelayAccountRuntime) {}

  public async sendText(input: {
    target: RelayResolvedTarget;
    text: string;
    replyToTransportMessageId?: string | null;
    sessionKey?: string;
    idempotencyKey?: string;
  }) {
    return await this.runtime.sendAction({
      kind: "message.send",
      target: input.target,
      payload: {
        text: input.text,
      },
      replyToTransportMessageId: input.replyToTransportMessageId,
      sessionKey: input.sessionKey,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public async sendMedia(input: {
    target: RelayResolvedTarget;
    text?: string;
    mediaUrl: string;
    fileName?: string;
    contentType?: string;
    asVoice?: boolean;
    forceDocument?: boolean;
    replyToTransportMessageId?: string | null;
    sessionKey?: string;
    idempotencyKey?: string;
  }) {
    return await this.runtime.sendAction({
      kind: "message.send",
      target: input.target,
      payload: {
        ...(input.text ? { text: input.text } : {}),
        mediaUrl: input.mediaUrl,
        ...(input.fileName ? { fileName: input.fileName } : {}),
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...(input.asVoice === true ? { asVoice: true } : {}),
        ...(input.forceDocument === true ? { forceDocument: true } : {}),
      },
      replyToTransportMessageId: input.replyToTransportMessageId,
      sessionKey: input.sessionKey,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public async requestFileDownload(input: {
    target: RelayResolvedTarget;
    fileId: string;
    idempotencyKey?: string;
  }) {
    return await this.runtime.sendAction({
      kind: "file.download.request",
      target: input.target,
      payload: {
        fileId: input.fileId,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }
}
