import { useEffect, useMemo, useState } from "react";
import { S3Service, type Credentials, type S3File } from "./aws/s3";
import { loadConfig, type AppConfig } from "./config";
import { describeError } from "./aws/errors";
import type { OfficeOptions } from "./office";
import { Login } from "./components/Login";
import { FileBrowser } from "./components/FileBrowser";
import { Viewer } from "./components/Viewer";

const SESSION_KEY = "collab.session";

function readSession(): Credentials | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(() => readSession());
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState<S3File | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    loadConfig().then((c) => {
      setConfig(c);
      if (c.title) document.title = c.title;
    });
  }, []);

  const service = useMemo(() => (creds ? new S3Service(creds) : null), [creds]);
  const office = useMemo<OfficeOptions>(() => ({ presignMinutes: config?.presignMinutes ?? 60 }), [config]);

  const login = async (c: Credentials) => {
    setBusy(true);
    setLoginError(null);
    try {
      const svc = new S3Service(c);
      await svc.testConnection();
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(c));
      setCreds(c);
    } catch (e: unknown) {
      setLoginError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setCreds(null);
    setOpenFile(null);
  };

  if (!config) return <div className="center muted">Loading…</div>;

  if (!service || !creds) {
    return <Login config={config} error={loginError} busy={busy} onLogin={login} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{config.title ?? "S3 Office Collab"}</div>
        <div className="spacer" />
        <div className="muted">
          <strong>{creds.displayName}</strong> · s3://{creds.bucket} · {creds.region}
        </div>
        <button className="btn ghost" onClick={logout}>
          Sign out
        </button>
      </header>

      <main className="content">
        <FileBrowser
          key={refreshToken}
          service={service}
          office={office}
          onOpen={(f) => setOpenFile(f)}
        />
      </main>

      {openFile && (
        <Viewer
          service={service}
          file={openFile}
          office={office}
          onClose={(changed) => {
            setOpenFile(null);
            if (changed) setRefreshToken((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}
