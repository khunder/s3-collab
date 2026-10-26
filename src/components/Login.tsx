import { useEffect, useState, type FormEvent } from "react";
import type { Credentials } from "../aws/s3";
import type { AppConfig } from "../config";

interface Props {
  config: AppConfig;
  error?: string | null;
  busy: boolean;
  onLogin: (creds: Credentials) => void;
}

const NAME_KEY = "collab.displayName";

export function Login({ config, error, busy, onLogin }: Props) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [endpoint, setEndpoint] = useState(config.endpoint ?? "");
  const [region, setRegion] = useState(config.region ?? "us-east-1");
  const [bucket, setBucket] = useState(config.bucket ?? "");
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem(NAME_KEY) ?? ""
  );
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    if (config.region) setRegion(config.region);
    if (config.bucket) setBucket(config.bucket);
  }, [config]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = displayName.trim() || accessKeyId.slice(-6);
    localStorage.setItem(NAME_KEY, name);
    onLogin({
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      sessionToken: sessionToken.trim() || undefined,
      region: region.trim(),
      bucket: bucket.trim(),
      displayName: name,
      endpoint: endpoint.trim() || undefined,
    });
  };

  const lockBucket = !!config.lockBucket && !!config.bucket;

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>{config.title ?? "S3 Office Collab"}</h1>
        <p className="muted">
          Sign in with your AWS access key. Keys stay in this browser tab only and
          are sent directly to AWS — never to any other server.
        </p>

        <label>
          Your name <span className="muted">(shown on locks)</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            autoComplete="name"
          />
        </label>

        <label>
          Access key ID
          <input
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="AKIA..."
          />
        </label>

        <label>
          Secret access key
          <div className="input-row">
            <input
              type={showSecret ? "text" : "password"}
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn ghost"
              onClick={() => setShowSecret((s) => !s)}
              title={showSecret ? "Hide" : "Show"}
            >
              {showSecret ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        <details>
          <summary className="muted">Advanced (session token, custom endpoint)</summary>
          <label>
            Session token <span className="muted">(only for temporary credentials)</span>
            <textarea
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value)}
              rows={2}
              spellCheck={false}
            />
          </label>
          <label>
            Endpoint URL <span className="muted">(leave empty for AWS S3)</span>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://s3.example.com"
              spellCheck={false}
            />
          </label>
        </details>

        <div className="grid-2">
          <label>
            Region
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              required
              disabled={lockBucket}
              placeholder="eu-west-1"
            />
          </label>
          <label>
            Bucket
            <input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              required
              disabled={lockBucket}
              placeholder="my-team-files"
            />
          </label>
        </div>

        {error && <div className="alert error">{error}</div>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
