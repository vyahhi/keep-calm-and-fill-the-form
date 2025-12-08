"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import styles from "./page.module.css";
import { DetectedField } from "@/lib/types";

type FieldValues = Record<string, string | boolean>;

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

const base64ToUint8Array = (base64: string) => {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string>();
  const [fields, setFields] = useState<DetectedField[]>([]);
  const [values, setValues] = useState<FieldValues>({});
  const [detecting, setDetecting] = useState(false);
  const [filling, setFilling] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("Form");
  const [split, setSplit] = useState(55); // percentage width for form panel
  const showStep2 = fields.length > 0;
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [filledPreviewUrl, setFilledPreviewUrl] = useState<string | null>(null);
  const [filledPreviewBase64, setFilledPreviewBase64] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [adjustments, setAdjustments] = useState<
    Record<string, { dx: number; dy: number; fontScale: number }>
  >({});

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      if (filledPreviewUrl) URL.revokeObjectURL(filledPreviewUrl);
    };
  }, [pdfUrl, filledPreviewUrl]);

  const hasForm = fields.length > 0;

  const resetAll = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    if (filledPreviewUrl) URL.revokeObjectURL(filledPreviewUrl);
    setFile(null);
    setPdfUrl(undefined);
    setFields([]);
    setValues({});
    setStatus(null);
    setDetecting(false);
    setFilling(false);
    setFormTitle("Form");
    setFilledPreviewUrl(null);
    setFilledPreviewBase64(null);
    setPreviewLoading(false);
    setAdjustments({});
  };

  const convertImageToPdf = async (imageFile: File) => {
    const bytes = new Uint8Array(await imageFile.arrayBuffer());
    const pdfDoc = await PDFDocument.create();
    let embedded;
    if (imageFile.type === "image/png") {
      embedded = await pdfDoc.embedPng(bytes);
    } else {
      embedded = await pdfDoc.embedJpg(bytes);
    }
    const { width, height } = embedded.scale(1);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
    const pdfBytes = await pdfDoc.save();
    const copy = new Uint8Array(pdfBytes.length);
    copy.set(pdfBytes);
    const blob = new Blob([copy], { type: "application/pdf" });
    const pdfFile = new File(
      [blob],
      imageFile.name.replace(/\.[^.]+$/, "") + ".pdf",
      { type: "application/pdf" },
    );
    return { file: pdfFile, url: URL.createObjectURL(blob) };
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);

    setFields([]);
    setValues({});
    setStatus(null);

    try {
      if (selected.type.startsWith("image/")) {
        const { file: pdfFile, url } = await convertImageToPdf(selected);
        setFile(pdfFile);
        setPdfUrl(url);
        setStatus("Image converted to PDF; detecting fields…");
      } else {
        setFile(selected);
        setPdfUrl(URL.createObjectURL(selected));
        setStatus("Detecting fields…");
      }
    } catch (error) {
      console.error(error);
      setStatus("Unable to convert image to PDF.");
    }
  };

  const detectFields = async (suppressStatus = false) => {
    if (!file || detecting) return;
    setDetecting(true);
    if (!suppressStatus) setStatus("Detecting fillable fields…");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/detect", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { fields?: DetectedField[]; error?: string; title?: string };
      if (!res.ok) {
        setStatus(data.error || "Detection failed");
        return;
      }
      setFields(data.fields || []);
      const initialValues: FieldValues = {};
      (data.fields || []).forEach((field) => {
        initialValues[field.name] =
          field.type === "checkbox" ? false : field.options?.[0] ?? "";
      });
      setValues(initialValues);
      setStatus(data.fields && data.fields.length > 0 ? null : "No fields detected");
      if (data.title && data.title.trim()) {
        setFormTitle(data.title.trim());
      } else {
        setFormTitle("Form");
      }
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error
          ? error.message
          : "Unable to detect fields. Check the file and API key.";
      setStatus(message);
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (file) {
      void detectFields();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const adjustedFields = useMemo(() => {
    return fields.map((field) => {
      const adj = adjustments[field.name];
      if (!adj || !field.bbox) return field;
      return {
        ...field,
        bbox: {
          ...field.bbox,
          x: field.bbox.x + adj.dx,
          y: field.bbox.y + adj.dy,
        },
        fontScale: adj.fontScale,
      };
    });
  }, [fields, adjustments]);

  const nudgeField = (fieldName: string, dir: "up" | "down" | "left" | "right") => {
    setAdjustments((prev) => {
      const current = prev[fieldName] || { dx: 0, dy: 0, fontScale: 1 };
      const delta = 0.005;
      const next = { ...current };
      if (dir === "up") next.dy -= delta;
      if (dir === "down") next.dy += delta;
      if (dir === "left") next.dx -= delta;
      if (dir === "right") next.dx += delta;
      return { ...prev, [fieldName]: next };
    });
    setPreviewLoading(true);
  };

  const scaleFieldFont = (fieldName: string, delta: number) => {
    setAdjustments((prev) => {
      const current = prev[fieldName] || { dx: 0, dy: 0, fontScale: 1 };
      const nextScale = Math.min(2, Math.max(0.5, current.fontScale + delta));
      return { ...prev, [fieldName]: { ...current, fontScale: nextScale } };
    });
    setPreviewLoading(true);
  };

  const renderAdjustButtons = (field: DetectedField) => (
    <div className={styles.nudgeGroup}>
      <button
        type="button"
        className={styles.nudgeBtn}
        onClick={() => nudgeField(field.name, "up")}
        title="Move up"
      >
        ↑
      </button>
      <div className={styles.nudgeRow}>
        <button
          type="button"
          className={styles.nudgeBtn}
          onClick={() => nudgeField(field.name, "left")}
          title="Move left"
        >
          ←
        </button>
        <button
          type="button"
          className={styles.nudgeBtn}
          onClick={() => nudgeField(field.name, "right")}
          title="Move right"
        >
          →
        </button>
      </div>
      <button
        type="button"
        className={styles.nudgeBtn}
        onClick={() => nudgeField(field.name, "down")}
        title="Move down"
      >
        ↓
      </button>
      <div className={styles.nudgeRow}>
        <button
          type="button"
          className={styles.nudgeBtn}
          onClick={() => scaleFieldFont(field.name, 0.05)}
          title="Increase font size"
        >
          +
        </button>
        <button
          type="button"
          className={styles.nudgeBtn}
          onClick={() => scaleFieldFont(field.name, -0.05)}
          title="Decrease font size"
        >
          -
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    if (!file || fields.length === 0) {
      if (filledPreviewUrl) URL.revokeObjectURL(filledPreviewUrl);
      setFilledPreviewUrl(null);
      setFilledPreviewBase64(null);
      return;
    }

    let active = true;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const base64 = arrayBufferToBase64(await file.arrayBuffer());
        const res = await fetch("/api/fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfBase64: base64, values, fields: adjustedFields }),
        });
        const data = (await res.json()) as { pdfBase64?: string; error?: string };
        if (!res.ok || !data.pdfBase64) {
          if (active) setStatus(data.error || "Unable to render preview.");
          return;
        }
        const filledBytes = base64ToUint8Array(data.pdfBase64);
        const filledBlob = new Blob([filledBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(filledBlob);
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        if (filledPreviewUrl) URL.revokeObjectURL(filledPreviewUrl);
        setFilledPreviewBase64(data.pdfBase64);
        setFilledPreviewUrl(url);
        setStatus((prev) => (prev && prev.includes("Unable") ? prev : null));
      } catch (error) {
        console.error("Preview generation error", error);
        if (active) setStatus("Unable to render preview.");
      } finally {
        if (active) setPreviewLoading(false);
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, adjustedFields, fields, file]);

  const downloadFilled = async () => {
    if (!file) return;
    try {
      let base64 = filledPreviewBase64;
      if (!base64) {
        const pdfBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const res = await fetch("/api/fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfBase64, values, fields: adjustedFields }),
        });
        const data = (await res.json()) as { pdfBase64?: string; error?: string };
        if (!res.ok || !data.pdfBase64) {
          setStatus(data.error || "Unable to download filled PDF.");
          return;
        }
        base64 = data.pdfBase64;
      }
      const filledBytes = base64ToUint8Array(base64);
      const filledBlob = new Blob([filledBytes], { type: "application/pdf" });
      const downloadUrl = URL.createObjectURL(filledBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = file.name.replace(/\.pdf$/i, "") + "-filled.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      console.error("Download error", error);
      setStatus("Unable to download filled PDF.");
    }
  };

  const updateValue = (name: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const renderField = (field: DetectedField) => {
    const value = values[field.name] ?? "";
    const commonProps = {
      id: field.name,
      name: field.name,
      value: typeof value === "string" ? value : "",
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        updateValue(field.name, event.target.value),
      placeholder: field.placeholder,
      className: styles.input,
    };

    if (field.type === "checkbox") {
      return (
        <div className={styles.field} key={field.name}>
          <label className={styles.label}>{field.label}</label>
          <div className={styles.inputRow}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                name={field.name}
                checked={Boolean(value)}
                onChange={(event) => updateValue(field.name, event.target.checked)}
              />
              <span>{field.label}</span>
            </label>
            {renderAdjustButtons(field)}
          </div>
        </div>
      );
    }

    if (field.type === "radio" && field.options?.length) {
      return (
        <div className={styles.field} key={field.name}>
          <span className={styles.label}>{field.label}</span>
          <div className={styles.radioRow}>
            {field.options.map((opt) => (
              <label key={opt} className={styles.radioLabel}>
                <input
                  type="radio"
                  name={field.name}
                  value={opt}
                  checked={value === opt}
                  onChange={(event) => updateValue(field.name, event.target.value)}
                />
                {opt}
              </label>
            ))}
          </div>
          {renderAdjustButtons(field)}
        </div>
      );
    }

    if (field.type === "select" && field.options?.length) {
      return (
        <div className={styles.field} key={field.name}>
          <label htmlFor={field.name} className={styles.label}>
            {field.label}
          </label>
          <div className={styles.inputRow}>
            <select
              {...commonProps}
              value={typeof value === "string" ? value : field.options[0]}
            >
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            {renderAdjustButtons(field)}
          </div>
        </div>
      );
    }

    return (
      <div className={styles.field} key={field.name}>
        <label htmlFor={field.name} className={styles.label}>
          {field.label}
        </label>
        <div className={styles.inputRow}>
          <input type={field.type || "text"} {...commonProps} />
          {renderAdjustButtons(field)}
        </div>
      </div>
    );
  };

  const onDrag = (clientX: number) => {
    const container = layoutRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const percent = Math.min(75, Math.max(25, (x / rect.width) * 100));
    setSplit(percent);
  };

  useEffect(() => {
    const handleMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      onDrag(ev.clientX);
    };
    const handleUp = () => {
      draggingRef.current = false;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const StepOne = () => (
    <div className={styles.page}>
      <div className={styles.containerBare}>
        <div className={styles.centerStack}>
          <div className={styles.poster}>
            <div className={styles.crown}>👑</div>
            <div className={styles.posterLine}>KEEP</div>
            <div className={styles.posterLine}>CALM</div>
            <div className={styles.posterLineSmall}>AND</div>
            <div className={styles.posterLine}>FILL THE</div>
            <div className={styles.posterLine}>FORM</div>
          </div>
          <label
            className={styles.dropZone}
            aria-disabled={detecting}
            style={{ pointerEvents: detecting ? "none" : "auto", opacity: detecting ? 0.6 : 1 }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) {
                const dt = new DataTransfer();
                dt.items.add(file);
                const input = e.currentTarget.querySelector("input");
                if (input) {
                  input.files = dt.files;
                  const event = new Event("change", { bubbles: true });
                  input.dispatchEvent(event);
                }
              }
            }}
          >
            <input
              type="file"
              accept="application/pdf,image/*"
              onChange={handleFileChange}
              disabled={detecting}
            />
            <div className={styles.dropContent}>
              <div className={styles.dropTitle}>
                {detecting ? "Detecting fillable fields…" : "Choose PDF or image"}
              </div>
              {!detecting && <div className={styles.dropHint}>or drag and drop here</div>}
            </div>
          </label>
          {!detecting ? (
            <p className={styles.subhead}>Upload any form and we’ll help you fill it</p>
          ) : null}
          {status && !detecting ? <p className={styles.status}>{status}</p> : null}
        </div>
      </div>
    </div>
  );

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {!showStep2 ? (
          <StepOne />
        ) : (
          <>
        <header className={styles.header}>
          <div className={styles.headerCopy}>
            <h1>Review detected fields, fill them out, and download an overlaid PDF</h1>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={resetAll}
              disabled={detecting || filling}
            >
              Choose new form
            </button>
          </div>
        </header>

        <main
          className={`${styles.layout} ${isDragging ? styles.dragging : ""}`}
          ref={layoutRef}
          onMouseLeave={() => {
            draggingRef.current = false;
            setIsDragging(false);
          }}
        >
          <section
            className={styles.formPanel}
            style={{ flexBasis: `${split}%`, minWidth: "42%" }}
          >
            <div className={styles.panelHeader}>
              <div>
                <h2>{formTitle}</h2>
              </div>
              <div className={styles.badgeRow}>
                <span className={styles.badge}>
                  {fields.length ? `${fields.length} field(s)` : "Awaiting detection"}
                </span>
                <button
                  className={styles.secondaryButtonSmall}
                  onClick={() => detectFields(true)}
                  disabled={!file || detecting}
                >
                  {detecting ? "Finding…" : "Re-run detection"}
                </button>
              </div>
            </div>

            {status && status.trim() ? (
              <div className={styles.status}>{status}</div>
            ) : null}

            {hasForm && <form className={styles.form}>{fields.map((field) => renderField(field))}</form>}

            <div className={styles.footerActions} />
          </section>

          <div
            className={styles.splitter}
            onMouseDown={(e) => {
              e.preventDefault();
              draggingRef.current = true;
              setIsDragging(true);
              onDrag(e.clientX);
            }}
          />
          <section
            className={styles.previewPanel}
            style={{ flexBasis: `${100 - split}%`, minWidth: "35%" }}
          >
            <div className={styles.panelHeader}>
              <h2>Preview</h2>
              <button
                type="button"
                className={styles.secondaryButtonSmall}
                onClick={downloadFilled}
                disabled={!file || previewLoading}
              >
                {previewLoading ? "Rendering…" : "Download⬇"}
              </button>
            </div>
            {previewLoading && <p className={styles.status}>Rendering preview…</p>}
            {filledPreviewUrl ? (
              <iframe
                title="PDF preview"
                src={filledPreviewUrl}
                className={styles.previewFrame}
              />
            ) : (
              <div className={styles.previewPlaceholder}>
                <p>Your filled PDF preview will appear here.</p>
              </div>
            )}
          </section>
        </main>
          </>
        )}
      </div>
    </div>
  );
}
