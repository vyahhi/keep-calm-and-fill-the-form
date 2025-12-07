"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const previewUrl = useMemo(() => pdfUrl || undefined, [pdfUrl]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const hasForm = fields.length > 0;

  const resetAll = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setFile(null);
    setPdfUrl(undefined);
    setFields([]);
    setValues({});
    setStatus(null);
    setDetecting(false);
    setFilling(false);
    setFormTitle("Form");
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
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
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
      setStatus(data.fields.length > 0 ? null : "No fields detected");
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

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setFilling(true);
    setStatus("Filling PDF…");
    try {
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const res = await fetch("/api/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfBase64: base64,
          values,
          fields,
        }),
      });
      const data = (await res.json()) as { pdfBase64?: string; error?: string };
      if (!res.ok) {
        setStatus(data.error || "Fill failed");
        return;
      }
      if (!data.pdfBase64) {
        setStatus("No PDF returned.");
        return;
      }
      const filledBytes = base64ToUint8Array(data.pdfBase64);
      const filledBlob = new Blob([filledBytes], {
        type: "application/pdf",
      });
      const downloadUrl = URL.createObjectURL(filledBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = file.name.replace(/\.pdf$/i, "") + "-filled.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      setStatus(null);
    } catch (error) {
      console.error(error);
      setStatus("Unable to fill the PDF.");
    } finally {
      setFilling(false);
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
        <label className={styles.checkboxLabel} key={field.name}>
          <input
            type="checkbox"
            name={field.name}
            checked={Boolean(value)}
            onChange={(event) => updateValue(field.name, event.target.checked)}
          />
          <span>{field.label}</span>
        </label>
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
                  onChange={(event) =>
                    updateValue(field.name, event.target.value)
                  }
                />
                {opt}
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (field.type === "select" && field.options?.length) {
      return (
        <div className={styles.field} key={field.name}>
          <label htmlFor={field.name} className={styles.label}>
            {field.label}
          </label>
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
        </div>
      );
    }

    return (
      <div className={styles.field} key={field.name}>
        <label htmlFor={field.name} className={styles.label}>
          {field.label}
        </label>
        <input type={field.type || "text"} {...commonProps} />
      </div>
    );
  };

  useMemo(() => {
    if (!file) return "Upload any form and we’ll help you fill it.";
    if (!hasForm) return "Finding fields to turn this file into a quick web form.";
    return "Review detected fields, fill them out, and download an overlaid PDF.";
  }, [file, hasForm]);

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
          <h1 className={styles.tagline}>Upload any form and we’ll help you fill it</h1>
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
              Upload new form
            </button>
          </div>
        </header>

        <main className={styles.layout} ref={layoutRef}>
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

            {hasForm && (
              <form className={styles.form} onSubmit={onSubmit}>
                {fields.map((field) => renderField(field))}
                <div className={styles.formActions}>
                  <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={filling}
                  >
                    {filling ? "Overlaying…" : "Apply answers & download an overlaid PDF"}
                  </button>
                </div>
              </form>
            )}

            <div className={styles.footerActions} />
          </section>

          <div
            className={styles.splitter}
            onMouseDown={(e) => {
              e.preventDefault();
              draggingRef.current = true;
              onDrag(e.clientX);
            }}
          />
          <section
            className={styles.previewPanel}
            style={{ flexBasis: `${100 - split}%`, minWidth: "35%" }}
          >
            <div className={styles.panelHeader}>
              <h2>Uploaded file</h2>
            </div>
            {previewUrl ? (
                  <iframe
                    title="PDF preview"
                    src={previewUrl}
                    className={styles.previewFrame}
                  />
                ) : (
                  <div className={styles.previewPlaceholder}>
                    <p>Your PDF preview will appear here.</p>
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
