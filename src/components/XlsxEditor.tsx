import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

interface Props {
  bytes: Uint8Array;
  ext: string;
  lockedByOther: boolean;
  onRequestLock: () => Promise<void>;
  onSave: (data: Uint8Array) => Promise<boolean>;
}

const MAX_ROWS = 1000;
const MAX_COLS = 100;

type Edits = Map<string, string>; // sheetName!A1 -> raw text

function bookTypeFor(ext: string): XLSX.BookType {
  switch (ext) {
    case "xlsm":
      return "xlsm";
    case "xls":
      return "biff8";
    case "csv":
      return "csv";
    default:
      return "xlsx";
  }
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (cell.w !== undefined) return cell.w;
  if (cell.v === undefined || cell.v === null) return "";
  if (cell.v instanceof Date) return cell.v.toLocaleDateString();
  return String(cell.v);
}

function applyEdit(ws: XLSX.WorkSheet, addr: string, raw: string) {
  const text = raw.trim();
  if (text === "") {
    delete ws[addr];
    return;
  }
  if (text.startsWith("=")) {
    ws[addr] = { t: "n", f: text.slice(1) } as XLSX.CellObject;
    return;
  }
  if (/^(true|false)$/i.test(text)) {
    ws[addr] = { t: "b", v: text.toLowerCase() === "true" };
    return;
  }
  if (/^-?\d+(\.\d+)?$/.test(text) || /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    ws[addr] = { t: "n", v: Number(text.replace(/,/g, "")) };
    return;
  }
  ws[addr] = { t: "s", v: text };
}

export function XlsxEditor({ bytes, ext, lockedByOther, onRequestLock, onSave }: Props) {
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Edits>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [extraRows, setExtraRows] = useState(0);
  const [extraCols, setExtraCols] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    try {
      const book = XLSX.read(bytes, { type: "array", cellNF: true, bookVBA: true, cellDates: false });
      setWb(book);
      setSheet((s) => (book.SheetNames.includes(s) ? s : book.SheetNames[0] ?? ""));
      setEdits(new Map());
      setEditing(false);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }, [bytes]);

  const ws = wb && sheet ? wb.Sheets[sheet] : undefined;

  const range = useMemo(() => {
    const base = ws?.["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 9, c: 5 } };
    const rows = Math.min(base.e.r + 1, MAX_ROWS) + (editing ? extraRows : 0);
    const cols = Math.min(base.e.c + 1, MAX_COLS) + (editing ? extraCols : 0);
    return { rows, cols, truncated: base.e.r + 1 > MAX_ROWS || base.e.c + 1 > MAX_COLS };
  }, [ws, editing, extraRows, extraCols]);

  const startEdit = async () => {
    setErr(null);
    if (lockedByOther) {
      setErr("This file is checked out by someone else. Ask them to check it in first (or force unlock from the toolbar).");
      return;
    }
    try {
      await onRequestLock();
      setEditing(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = () => {
    setEdits(new Map());
    setEditing(false);
    setExtraRows(0);
    setExtraCols(0);
  };

  const save = async () => {
    if (!wb) return;
    if (edits.size === 0) {
      setEditing(false);
      return;
    }
    const ok = window.confirm(
      "Save changes to S3?\n\nNote: the in-browser editor keeps values and formulas, but rich formatting (styles, charts, images, pivot tables) may be lost. For heavy editing use \"Open in Excel\" and upload the new version."
    );
    if (!ok) return;

    setBusy(true);
    setErr(null);
    try {
      const copy = XLSX.read(bytes, { type: "array", cellNF: true, bookVBA: true });
      for (const [k, raw] of edits) {
        const bang = k.indexOf("!");
        const sName = k.slice(0, bang);
        const addr = k.slice(bang + 1);
        const target = copy.Sheets[sName];
        if (!target) continue;
        applyEdit(target, addr, raw);
        const cur = target["!ref"] ? XLSX.utils.decode_range(target["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
        const a = XLSX.utils.decode_cell(addr);
        cur.e.r = Math.max(cur.e.r, a.r);
        cur.e.c = Math.max(cur.e.c, a.c);
        target["!ref"] = XLSX.utils.encode_range(cur);
      }
      const wbAny = copy as XLSX.WorkBook & { Workbook?: Record<string, unknown> };
      wbAny.Workbook = { ...(wbAny.Workbook ?? {}), CalcPr: { fullCalcOnLoad: true } };

      const out = XLSX.write(copy, { type: "array", bookType: bookTypeFor(ext), bookVBA: ext === "xlsm" }) as ArrayBuffer;
      const saved = await onSave(new Uint8Array(out));
      if (saved) {
        setEdits(new Map());
        setEditing(false);
        setExtraRows(0);
        setExtraCols(0);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (parseError) return <div className="alert error">Could not read this workbook: {parseError}</div>;
  if (!wb || !ws) return <div className="muted center">Loading workbook…</div>;

  const editCount = edits.size;

  return (
    <div className="xlsx">
      <div className="xlsx-tools">
        <div className="tabs">
          {wb.SheetNames.map((n) => (
            <button key={n} className={n === sheet ? "on" : ""} onClick={() => setSheet(n)}>
              {n}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {range.truncated && (
          <span className="muted" title={`Showing first ${MAX_ROWS} rows × ${MAX_COLS} columns`}>
            Large sheet: view truncated
          </span>
        )}
        {!editing ? (
          <button className="btn primary" onClick={startEdit} disabled={busy}>
            Edit cells
          </button>
        ) : (
          <>
            <button className="btn sm" onClick={() => setExtraRows((n) => n + 10)}>
              + 10 rows
            </button>
            <button className="btn sm" onClick={() => setExtraCols((n) => n + 5)}>
              + 5 cols
            </button>
            <span className="muted">{editCount} change{editCount === 1 ? "" : "s"}</span>
            <button className="btn" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={busy || editCount === 0}>
              {busy ? "Saving…" : "Save to S3"}
            </button>
          </>
        )}
      </div>
      {err && <div className="alert error">{err}</div>}

      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="rowhead" />
              {Array.from({ length: range.cols }, (_, c) => (
                <th key={c}>{XLSX.utils.encode_col(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: range.rows }, (_, r) => (
              <tr key={r}>
                <th className="rowhead">{r + 1}</th>
                {Array.from({ length: range.cols }, (_, c) => {
                  const addr = XLSX.utils.encode_cell({ r, c });
                  const key = `${sheet}!${addr}`;
                  const cell = ws[addr] as XLSX.CellObject | undefined;
                  const edited = edits.has(key);
                  const value = edited ? edits.get(key)! : cellText(cell);
                  const isActive = editing && active === key;
                  return (
                    <td
                      key={c}
                      className={`${edited ? "edited" : ""} ${cell?.t === "n" ? "num" : ""} ${cell?.f ? "formula" : ""}`}
                      title={cell?.f ? `=${cell.f}` : undefined}
                      onClick={() => editing && setActive(key)}
                    >
                      {isActive ? (
                        <input
                          autoFocus
                          defaultValue={edited ? value : cell?.f ? `=${cell.f}` : value}
                          onBlur={(e) => {
                            const v = e.target.value;
                            const original = cell?.f ? `=${cell.f}` : cellText(cell);
                            setEdits((m) => {
                              const next = new Map(m);
                              if (v === original) next.delete(key);
                              else next.set(key, v);
                              return next;
                            });
                            setActive(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                              const nr = e.key === "Enter" ? r + 1 : r;
                              const nc = e.key === "Tab" ? c + 1 : c;
                              if (nr < range.rows && nc < range.cols) {
                                setTimeout(() => setActive(`${sheet}!${XLSX.utils.encode_cell({ r: nr, c: nc })}`), 0);
                              }
                            } else if (e.key === "Escape") {
                              (e.target as HTMLInputElement).value = edited ? value : cellText(cell);
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                        />
                      ) : (
                        value
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
