import type { RelayActionSuccess } from "../api.js";
import { downloadTokenSchema, uploadPlanSchema } from "./protocol/data-plane.js";

export class RelayFileDataPlane {
  public constructor(
    private readonly dataPlane: { uploadBaseUrl: string; downloadBaseUrl: string }
  ) {}

  public createUploadPlan(input: {
    accountId: string;
    actionId: string;
    token: string;
    expiresAtMs: number;
  }) {
    return uploadPlanSchema.parse({
      ...input,
      uploadUrl: `${this.dataPlane.uploadBaseUrl}/${input.token}`,
    });
  }

  public createDownloadToken(input: {
    accountId: string;
    actionId: string;
    token: string;
    expiresAtMs: number;
  }) {
    return downloadTokenSchema.parse({
      ...input,
      downloadUrl: `${this.dataPlane.downloadBaseUrl}/${input.token}`,
    });
  }

  public fromActionResult(result: RelayActionSuccess) {
    if (result.uploadUrl && result.token) {
      return uploadPlanSchema.parse({
        actionId: "unknown",
        accountId: "unknown",
        uploadUrl: result.uploadUrl,
        token: result.token,
        expiresAtMs: Date.now() + 60_000,
      });
    }

    if (result.downloadUrl && result.token) {
      return downloadTokenSchema.parse({
        actionId: "unknown",
        accountId: "unknown",
        downloadUrl: result.downloadUrl,
        token: result.token,
        expiresAtMs: Date.now() + 60_000,
      });
    }

    throw new Error("Action result does not contain a data-plane URL");
  }
}
