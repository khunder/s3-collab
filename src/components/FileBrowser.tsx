import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  S3Service,
  extensionOf,
  formatBytes,
  officeAppName,
  type Listing,
  type LockInfo,
  type S3File,
} from "../aws/s3";
import { describeError } from "../aws/errors";
import { openInOffice, type OfficeOptions } from "../office";

interface Props {
  service: S3Service;
  office: OfficeOptions;
  onOpen: (file: S3File) => void;
}

const PATH_KEY = "collab.path";

export function fileIcon(key: string): string {
  const ext = extensionOf(key);
  if (["pptx", "ppt", "pptm"].includes(ext)) return "📙";
  if (["xlsx", "xls", "xlsm", "csv"].includes(ext)) return "📗";
  if (["docx", "doc"].includes(ext)) return "📘";
  if (ext === "pdf") return "📕";
  if (["png", "jpg", "jpeg", "gif", "svg"].includes(ext)) return "🖼️";
  return "📄";
}

export function FileBrowser({ service, office, onOpen }: Props) {
  const [prefix, setPrefix] = useState(() => sessionStorage.getItem(PATH_KEY) ?? "");
  const [listing, setListing] = useState<Listing>({ folders: [], files: [] });
  const [locks, setLocks] = useState<Record<string, LockInfo>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const l = await service.list(prefix);
      setListing(l);
      service
        .getLocks(l.files.map((f) => f.key))
        .then(setLocks)
        .catch(() => setLocks({}));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [service, prefix]);

  useEffect(() => {
    sessionStorage.setItem(PATH_KEY, prefix);
    refresh();
  }, [prefix, refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setProgress(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setProgress(null);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    const uploaded: S3File[] = [];
    await run(`Uploading ${arr.length} file(s)…`, async () => {
      for (let i = 0; i < arr.length; i++) {
        const f = arr[i];
        setProgress(`Uploading ${i + 1}/${arr.length}: ${f.name}`);
        await service.upload(prefix + f.name, f, f.type || undefined);
        uploaded.push({ key: prefix + f.name, name: f.name, size: f.size, lastModified: new Date() });
      }
    });
    // Listing is read-after-write consistent on S3, but be tolerant of lagging S3-compatible stores.
    setListing((l) => {
      const missing = uploaded.filter((u) => !l.files.some((f) => f.key === u.key));
      if (!missing.length) return l;
      return { ...l, files: [...l.files, ...missing].sort((a, b) => a.name.localeCompare(b.name)) };
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  };

  const newFolder = () => {
    const name = window.prompt("Folder name:");
    if (!name?.trim()) return;
    const clean = name.trim().replace(/[\\/]+/g, "-");
    run("Creating folder…", () => service.createFolder(prefix + clean + "/"));
  };

  const rename = (f: S3File) => {
    const name = window.prompt("New name:", f.name);
    if (!name?.trim() || name === f.name) return;
    const clean = name.trim().replace(/[\\/]+/g, "-");
    run("Renaming…", () => service.move(f.key, prefix + clean));
  };

  const remove = (f: S3File) => {
    if (!window.confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
    run("Deleting…", () => service.remove(f.key));
  };

  const download = async (f: S3File) => {
    try {
      const url = await service.presignDownload(f.key, 10, false);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.rel = "noopener";
      a.click();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const launchOffice = async (f: S3File) => {
    setError(null);
    try {
      await openInOffice(service, f, office);
    } catch (e) {
      if ((e as Error)?.message !== "cancelled") setError(describeError(e));
    }
  };

  const toggleLock = (f: S3File) => {
    const lock = locks[f.key];
    if (lock && lock.user !== service.user) {
      if (!window.confirm(`This file is checked out by ${lock.user}. Force unlock?`)) return;
      run("Unlocking…", () => service.releaseLock(f.key));
    } else if (lock) {
      run("Checking in…", () => service.releaseLock(f.key));
    } else {
      run("Checking out…", async () => {
        await service.acquireLock(f.key);
      });
    }
  };

  const crumbs = prefix.split("/").filter(Boolean);
  const q = filter.trim().toLowerCase();
  const folders = listing.folders.filter((d) => !q || d.name.toLowerCase().includes(q));
  const files = listing.files.filter((f) => !q || f.name.toLowerCase().includes(q));

  return (
    <div
      className={`browser ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="toolbar">
        <nav className="crumbs">
          <button className="link" onClick={() => setPrefix("")}>
            {service.bucket}
          </button>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join("/") + "/";
            return (
              <span key={p}>
                <span className="sep">/</span>
                <button className="link" onClick={() => setPrefix(p)}>
                  {c}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="spacer" />
        <input
          className="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn" onClick={refresh} disabled={loading}>
          Refresh
        </button>
        <button className="btn" onClick={newFolder}>
          New folder
        </button>
        <button className="btn primary" onClick={() => fileInput.current?.click()}>
          Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error && <div className="alert error">{error}</div>}
      {progress && <div className="alert info">{progress}</div>}

      <table className="files">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Size</th>
            <th>Modified</th>
            <th>Status</th>
            <th className="actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {prefix && (
            <tr className="row-folder">
              <td colSpan={5}>
                <button
                  className="link"
                  onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ""))}
                >
                  ⬆️ ..
                </button>
              </td>
            </tr>
          )}
          {folders.map((d) => (
            <tr key={d.prefix} className="row-folder">
              <td colSpan={5}>
                <button className="link" onClick={() => setPrefix(d.prefix)}>
                  📁 {d.name}
                </button>
              </td>
            </tr>
          ))}
          {files.map((f) => {
            const lock = locks[f.key];
            const app = officeAppName(f.key);
            return (
              <tr key={f.key}>
                <td>
                  <button className="link" onClick={() => onOpen(f)} title="Open preview">
                    {fileIcon(f.key)} {f.name}
                  </button>
                </td>
                <td className="num">{formatBytes(f.size)}</td>
                <td>{f.lastModified?.toLocaleString() ?? ""}</td>
                <td>
                  {lock ? (
                    <span
                      className={`badge ${lock.user === service.user ? "mine" : "locked"}`}
                      title={`Since ${new Date(lock.since).toLocaleString()}`}
                    >
                      🔒 {lock.user === service.user ? "You" : lock.user}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="actions">
                  <button className="btn sm" onClick={() => onOpen(f)}>
                    Open
                  </button>
                  {app && (
                    <button
                      className="btn sm"
                      onClick={() => launchOffice(f)}
                      title={`Open a copy in desktop ${app} (upload the new version afterwards)`}
                    >
                      {app}
                    </button>
                  )}
                  <button className="btn sm" onClick={() => download(f)}>
                    Download
                  </button>
                  <button className="btn sm" onClick={() => toggleLock(f)}>
                    {lock ? "Check in" : "Check out"}
                  </button>
                  <button className="btn sm" onClick={() => rename(f)}>
                    Rename
                  </button>
                  <button className="btn sm danger" onClick={() => remove(f)}>
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
          {!loading && !folders.length && !files.length && (
            <tr>
              <td colSpan={5} className="muted center">
                {q ? "No matches." : "Empty folder. Drag & drop files here or click Upload."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {loading && <div className="muted center">Loading…</div>}
      {dragging && <div className="drop-hint">Drop files to upload to /{prefix}</div>}
    </div>
  );
}
