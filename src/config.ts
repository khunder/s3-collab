export interface AppConfig {
  bucket?: string;
  region?: string;
  lockBucket?: boolean;
  title?: string;
  presignMinutes?: number;
  endpoint?: string;
}

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    cached = res.ok ? ((await res.json()) as AppConfig) : {};
  } catch {
    cached = {};
  }
  return cached;
}
