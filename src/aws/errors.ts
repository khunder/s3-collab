export function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const name = err?.name ?? "";
  const msg = err?.message ?? String(e);
  if (name === "InvalidAccessKeyId") return "Access key ID is not valid.";
  if (name === "SignatureDoesNotMatch") return "Secret access key is not valid.";
  if (name === "ExpiredToken" || name === "InvalidToken") return "The session token is expired or invalid.";
  if (name === "AccessDenied") return "Access denied. Check the IAM policy for this user and bucket.";
  if (name === "NoSuchBucket") return "That bucket does not exist in the selected region.";
  if (name === "PermanentRedirect" || /endpoint/i.test(msg)) return "Wrong region for this bucket.";
  if (name === "TypeError" && /fetch|network/i.test(msg)) {
    return "Network error. Usually the bucket's CORS configuration does not allow this site's origin.";
  }
  return `${name ? name + ": " : ""}${msg}`;
}
