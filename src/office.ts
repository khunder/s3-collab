import { S3Service, officeProtocolUrl, type S3File } from "./aws/s3";

export interface OfficeOptions {
  presignMinutes: number;
}

/**
 * Launch the desktop Office app on a copy of the file (presigned URL).
 * Users edit locally and then use "Upload new version".
 */
export async function openInOffice(service: S3Service, file: S3File, opts: OfficeOptions): Promise<void> {
  const url = await service.presignDownload(file.key, Math.max(opts.presignMinutes, 120), true);
  const proto = officeProtocolUrl(file.key, url);
  if (proto) window.location.href = proto;
}
