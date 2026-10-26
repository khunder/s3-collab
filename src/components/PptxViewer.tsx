import { useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";

interface Props {
  bytes: Uint8Array;
}

type Mode = "list" | "slide";

export function PptxViewer({ bytes }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("slide");
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    el.innerHTML = "";
    setRendering(true);
    setError(null);

    const available = Math.max(320, el.clientWidth - 48);
    const width = Math.min(available, 1280);
    const height = Math.round((width * 9) / 16);

    const previewer = init(el, { width, height, mode });
    const copy = bytes.slice().buffer;
    previewer
      .preview(copy)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRendering(false));

    return () => {
      try {
        previewer.destroy();
      } catch {
        /* ignore */
      }
      el.innerHTML = "";
    };
  }, [bytes, mode]);

  return (
    <div className="pptx">
      <div className="pptx-tools">
        <span className="muted">
          Read-only preview (layout approximation). Download or "Open in PowerPoint" to edit, then "Upload new version".
        </span>
        <div className="spacer" />
        <div className="seg">
          <button className={mode === "slide" ? "on" : ""} onClick={() => setMode("slide")}>
            Slide
          </button>
          <button className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>
            All slides
          </button>
        </div>
      </div>
      {rendering && <div className="muted center">Rendering slides…</div>}
      {error && <div className="alert error">Could not render this presentation: {error}</div>}
      <div ref={container} className="pptx-canvas" />
    </div>
  );
}
