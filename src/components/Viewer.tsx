import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  S3Service,
  extensionOf,
  officeAppName,
  type LockInfo,
  type S3File,
} from "../aws/s3";
import { describeError } from "../aws/errors";
import { openInOffice as launchOffice, type OfficeOptions } from "../office";
import { fileIcon } from "./FileBrowser";

const PptxViewer = lazy(() => import("./PptxViewer").then((m) => ({ default: m.PptxViewer })));
const XlsxEditor = lazy(() => import("./XlsxEditor").then((m) => ({ default: m.XlsxEditor })));

interface Props {
  service: S3Service;
  file: S3File;
  office: OfficeOptions;
  onClose: (changed: boolean) => void;
}

export function Viewer({ service, file, office, onClose }: Props) {
  const presignMinutes = office.presignMinutes;
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [etag, setEtag] = useState<string | undefined>(file.etag);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>("Downloading…");
  const [inlineUrl, setInlineUrl] = useState<string | null>(null);
  const changed = useRef(false);
  const replaceInput = useRef<HTMLInputElement>(null);

  const ext = extensionOf(file.key);
  const isPptx = ext === "pptx";
  const isSheet = ["xlsx", "xlsm", "xls", "csv"].includes(ext);
  const isInline = ["pdf", "png", "jpg", "jpeg", "gif", "svg", "txt", "md", "json"].includes(ext);

  const load = async () => {
    setStatus("Downloading…");
    setError(null);
    try {
      const [head, lk] = await Promise.all([
        service.head(file.key),
        service.getLock(file.key).catch(() => null),
      ]);
      setEtag(head.ETag);
      setLock(lk);
      if (isPptx || isSheet) {
        setBytes(await service.download(file.key));
      } else if (isInline) {
        setInlineUrl(await service.presignDownload(file.key, presignMinutes, true));
      }
      setStatus(null);
    } catch (e) {
      setError(describeError(e));
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(changed.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file.key]);

  const download = async () => {
    try {
      const url = await service.presignDownload(file.key, 10, false);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const openInOffice = async () => {
    setError(null);
    try {
      await launchOffice(service, file, office);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const toggleLock = async () => {
    setError(null);
    try {
      if (lock && lock.user !== service.user) {
        if (!window.confirm(`Checked out by ${lock.user}. Force unlock?`)) return;
        await service.releaseLock(file.key);
        setLock(null);
      } else if (lock) {
        await service.releaseLock(file.key);
        setLock(null);
      } else {
        setLock(await service.acquireLock(file.key));
      }
      changed.current = true;
    } catch (e) {
      setError(describeError(e));
    }
  };

  const saveBytes = async (data: Uint8Array, label = "Saving…") => {
    setStatus(label);
    setError(null);
    try {
      const head = await service.head(file.key).catch(() => null);
      if (head?.ETag && etag && head.ETag !== etag) {
        const ok = window.confirm(
          "Someone else uploaded a newer version of this file while you had it open. Overwrite it anyway?"
        );
        if (!ok) {
          setStatus(null);
          return false;
        }
      }
      await service.upload(file.key, data);
      const fresh = await service.head(file.key);
      setEtag(fresh.ETag);
      setBytes(data);
      changed.current = true;
      setStatus(null);
      return true;
    } catch (e) {
      setError(describeError(e));
      setStatus(null);
      return false;
    }
  };

  const replaceWithFile = async (f: File) => {
    const ok = await saveBytes(new Uint8Array(await f.arrayBuffer()), `Uploading ${f.name}…`);
    if (ok && lock?.user === service.user) {
      const release = window.confirm("Uploaded. Check the file back in (release your lock)?");
      if (release) {
        await service.releaseLock(file.key).catch(() => undefined);
        setLock(null);
      }
    }
  };

  const app = officeAppName(file.key);

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <button className="btn" onClick={() => onClose(changed.current)}>
          ← Back
        </button>
        <div className="viewer-title" title={file.key}>
          {fileIcon(file.key)} {file.name}
        </div>
        {lock && (
          <span className={`badge ${lock.user === service.user ? "mine" : "locked"}`}>
            🔒 {lock.user === service.user ? "Checked out by you" : `Checked out by ${lock.user}`}
          </span>
        )}
        <div className="spacer" />
        {status && <span className="muted">{status}</span>}
        <button className="btn" onClick={toggleLock}>
          {lock ? "Check in" : "Check out"}
        </button>
        {app && (
          <button className="btn" onClick={openInOffice} title={`Open a copy in desktop ${app}`}>
            Open in {app}
          </button>
        )}
        <button className="btn" onClick={download}>
          Download
        </button>
        <button className="btn primary" onClick={() => replaceInput.current?.click()}>
          Upload new version
        </button>
        <input
          ref={replaceInput}
          type="file"
          hidden
          accept={`.${ext}`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) replaceWithFile(f);
            e.target.value = "";
          }}
        />
      </header>

      {error && <div className="alert error">{error}</div>}

      <div className="viewer-body">
        <Suspense fallback={<div className="muted center">Loading viewer…</div>}>
          {isPptx && bytes && <PptxViewer bytes={bytes} />}
          {isSheet && bytes && (
            <XlsxEditor
              bytes={bytes}
              ext={ext}
              lockedByOther={!!lock && lock.user !== service.user}
              onRequestLock={async () => {
                const l = await service.acquireLock(file.key);
                setLock(l);
                changed.current = true;
              }}
              onSave={(data) => saveBytes(data)}
            />
          )}
        </Suspense>
        {isInline && inlineUrl && (
          ["png", "jpg", "jpeg", "gif", "svg"].includes(ext) ? (
            <img className="inline-img" src={inlineUrl} alt={file.name} />
          ) : (
            <iframe className="inline-frame" src={inlineUrl} title={file.name} />
          )
        )}
        {!isPptx && !isSheet && !isInline && !status && (
          <div className="center muted">
            <p>No in-browser preview for <code>.{ext}</code> files.</p>
            <p>
              <button className="btn" onClick={download}>Download</button>{" "}
              {office && <button className="btn" onClick={openInOffice}>Open in Office</button>}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
