import { z } from "zod";

const loopbackUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}, "Data plane URL must be loopback");

export const uploadPlanSchema = z.object({
  actionId: z.string(),
  accountId: z.string(),
  uploadUrl: loopbackUrlSchema,
  token: z.string(),
  expiresAtMs: z.number().int().positive(),
});

export const downloadTokenSchema = z.object({
  actionId: z.string(),
  accountId: z.string(),
  downloadUrl: loopbackUrlSchema,
  token: z.string(),
  expiresAtMs: z.number().int().positive(),
});

export type UploadPlan = z.infer<typeof uploadPlanSchema>;
export type DownloadToken = z.infer<typeof downloadTokenSchema>;
