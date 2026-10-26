import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  bucket: string;
  displayName: string;
  endpoint?: string;
}

export interface S3Folder {
  name: string;
  prefix: string;
}

export interface S3File {
  key: string;
  name: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export interface Listing {
  folders: S3Folder[];
  files: S3File[];
}

export interface LockInfo {
  user: string;
  since: string;
}

const LOCK_PREFIX = ".locks/";

export const CONTENT_TYPES: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

export function extensionOf(key: string): string {
  const name = key.split("/").pop() ?? "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extensionOf(key)] ?? "application/octet-stream";
}

export class S3Service {
  private client: S3Client;
  readonly bucket: string;
  readonly user: string;

  constructor(creds: Credentials) {
    this.bucket = creds.bucket;
    this.user = creds.displayName;
    this.client = new S3Client({
      region: creds.region,
      ...(creds.endpoint ? { endpoint: creds.endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken || undefined,
      },
      // Avoid CRC checksum headers/trailers that complicate browser CORS setups.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async testConnection(): Promise<void> {
    await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 })
    );
  }

  async list(prefix: string): Promise<Listing> {
    const folders: S3Folder[] = [];
    const files: S3File[] = [];
    let token: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: token,
        })
      );
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix || cp.Prefix === LOCK_PREFIX) continue;
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, "");
        folders.push({ name, prefix: cp.Prefix });
      }
      for (const obj of (res.Contents ?? []) as _Object[]) {
        if (!obj.Key || obj.Key === prefix) continue;
        if (obj.Key.endsWith("/")) continue;
        files.push({
          key: obj.Key,
          name: obj.Key.slice(prefix.length),
          size: obj.Size ?? 0,
          lastModified: obj.LastModified,
          etag: obj.ETag,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { folders, files };
  }

  async download(key: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (!res.Body) throw new Error("Empty response body");
    return res.Body.transformToByteArray();
  }

  async upload(
    key: string,
    body: Blob | Uint8Array | ArrayBuffer,
    contentType?: string
  ): Promise<void> {
    const bytes =
      body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : body;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType ?? contentTypeFor(key),
        ContentLength: bytes.byteLength,
        Metadata: { "modified-by": encodeURIComponent(this.user) },
      })
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
    await this.releaseLock(key).catch(() => undefined);
  }

  async createFolder(prefix: string): Promise<void> {
    const key = prefix.endsWith("/") ? prefix : prefix + "/";
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: new Uint8Array(0), ContentLength: 0 })
    );
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `/${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
        Key: toKey,
        ContentType: contentTypeFor(toKey),
        MetadataDirective: "REPLACE",
        Metadata: { "modified-by": encodeURIComponent(this.user) },
      })
    );
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey })
    );
  }

  async head(key: string) {
    return this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async presignDownload(key: string, minutes = 60, inline = false): Promise<string> {
    const name = key.split("/").pop() ?? "file";
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`,
        ResponseContentType: contentTypeFor(key),
      }),
      { expiresIn: minutes * 60 }
    );
  }

  // ---- Soft locks (check-out / check-in) stored as sidecar objects ----

  private lockKey(key: string) {
    return `${LOCK_PREFIX}${key}.lock.json`;
  }

  async getLock(key: string): Promise<LockInfo | null> {
    try {
      const bytes = await this.download(this.lockKey(key));
      return JSON.parse(new TextDecoder().decode(bytes)) as LockInfo;
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw e;
    }
  }

  async getLocks(keys: string[]): Promise<Record<string, LockInfo>> {
    const out: Record<string, LockInfo> = {};
    const prefixes = new Set(keys.map((k) => k.slice(0, k.lastIndexOf("/") + 1)));
    for (const p of prefixes) {
      let token: string | undefined;
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${LOCK_PREFIX}${p}`,
            Delimiter: "/",
            ContinuationToken: token,
          })
        );
        for (const obj of res.Contents ?? []) {
          const k = obj.Key ?? "";
          if (!k.endsWith(".lock.json")) continue;
          const original = k.slice(LOCK_PREFIX.length, -".lock.json".length);
          if (keys.includes(original)) {
            const info = await this.getLock(original);
            if (info) out[original] = info;
          }
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    }
    return out;
  }

  async acquireLock(key: string): Promise<LockInfo> {
    const existing = await this.getLock(key);
    if (existing && existing.user !== this.user) {
      throw new Error(`Locked by ${existing.user} since ${new Date(existing.since).toLocaleString()}`);
    }
    const info: LockInfo = { user: this.user, since: new Date().toISOString() };
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.lockKey(key),
        Body: new TextEncoder().encode(JSON.stringify(info)),
        ContentType: "application/json",
      })
    );
    return info;
  }

  async releaseLock(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.lockKey(key) })
    );
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function officeScheme(key: string): "ms-powerpoint" | "ms-excel" | "ms-word" | null {
  const ext = extensionOf(key);
  if (["pptx", "ppt", "pptm"].includes(ext)) return "ms-powerpoint";
  if (["xlsx", "xls", "xlsm", "csv"].includes(ext)) return "ms-excel";
  if (["docx", "doc", "docm"].includes(ext)) return "ms-word";
  return null;
}

export function officeAppName(key: string): string | null {
  const s = officeScheme(key);
  return s === "ms-powerpoint" ? "PowerPoint" : s === "ms-excel" ? "Excel" : s === "ms-word" ? "Word" : null;
}

/** ms-powerpoint:ofe|u|<url> style link that launches the desktop app on a URL. */
export function officeProtocolUrl(key: string, fileUrl: string): string | null {
  const scheme = officeScheme(key);
  return scheme ? `${scheme}:ofe|u|${fileUrl}` : null;
}

/** URL of an object on the WebDAV gateway (editable in place by desktop Office). */
export function webdavFileUrl(webdavBase: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${webdavBase.replace(/\/+$/, "")}/${path}`;
}
