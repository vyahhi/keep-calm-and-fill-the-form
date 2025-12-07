import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb } from "pdf-lib";
import { DetectedField, FillPayload } from "@/lib/types";

export const runtime = "nodejs";

type PdfFieldKind = "text" | "checkbox" | "radio" | "dropdown" | "optionlist" | "unknown";

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function detectFieldKind(
  form: ReturnType<PDFDocument["getForm"]>,
  name: string,
): PdfFieldKind {
  try {
    form.getTextField(name);
    return "text";
  } catch {
    // fall through
  }
  try {
    form.getCheckBox(name);
    return "checkbox";
  } catch {
    // fall through
  }
  try {
    form.getRadioGroup(name);
    return "radio";
  } catch {
    // fall through
  }
  try {
    form.getDropdown(name);
    return "dropdown";
  } catch {
    // fall through
  }
  try {
    form.getOptionList(name);
    return "optionlist";
  } catch {
    // fall through
  }
  return "unknown";
}

function resolveFieldName(
  requested: string,
  available: string[],
  kindMap: Map<string, PdfFieldKind>,
  preferredKinds: PdfFieldKind[] = [],
) {
  const normalizedRequested = normalize(requested);
  const exact = available.find((name) => name === requested);
  if (exact) return exact;

  const caseInsensitive = available.find(
    (name) => name.toLowerCase() === requested.toLowerCase(),
  );
  if (caseInsensitive) return caseInsensitive;

  const normalizedMatch = available.find(
    (name) => normalize(name) === normalizedRequested,
  );
  if (normalizedMatch) return normalizedMatch;

  const contains = available.filter((name) =>
    normalize(name).includes(normalizedRequested),
  );
  if (contains.length === 1) return contains[0];
  if (contains.length > 1 && preferredKinds.length) {
    const kindMatch = contains.find((name) =>
      preferredKinds.includes(kindMap.get(name) ?? "unknown"),
    );
    if (kindMatch) return kindMatch;
  }

  return null;
}

async function applyValueToField(
  form: ReturnType<PDFDocument["getForm"]>,
  fieldName: string,
  value: string | boolean,
) {
  const normalized =
    typeof value === "boolean" ? (value ? "Yes" : "Off") : String(value);

  try {
    const textField = form.getTextField(fieldName);
    textField.setText(String(value));
    return;
  } catch {
    // not a text field
  }

  try {
    const checkbox = form.getCheckBox(fieldName);
    if (typeof value === "boolean") {
      if (value) {
        checkbox.check();
      } else {
        checkbox.uncheck();
      }
    } else if (normalized.toLowerCase() === "true") {
      checkbox.check();
    } else {
      checkbox.uncheck();
    }
    return;
  } catch {
    // not a checkbox
  }

  try {
    const radio = form.getRadioGroup(fieldName);
    radio.select(String(value));
    return;
  } catch {
    // not a radio group
  }

  try {
    const dropdown = form.getDropdown(fieldName);
    dropdown.select(String(value));
    return;
  } catch {
    // not a dropdown
  }

  try {
    const list = form.getOptionList(fieldName);
    list.select(String(value));
  } catch {
    // swallow if field is unknown
    console.warn(`Unable to fill field "${fieldName}"`);
  }
}

function drawValueAtBBox(
  pdfDoc: PDFDocument,
  field: DetectedField,
  value: string | boolean,
) {
  if (!field.bbox) return;
  const pages = pdfDoc.getPages();
  let pageIndex = Math.round(field.bbox.page ?? 0);
  if (pageIndex >= pages.length && pageIndex > 0) {
    pageIndex -= 1; // treat incoming pages as 1-based if out of range
  }
  pageIndex = Math.max(0, Math.min(pages.length - 1, pageIndex));
  const page = pages[pageIndex];
  if (!page) return;

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const isNormalized =
    field.bbox.x <= 1 && field.bbox.y <= 1 && (field.bbox.width ?? 0) <= 1 && (field.bbox.height ?? 0) <= 1;

  const rawWidth = field.bbox.width ?? (isNormalized ? 0.4 : pageWidth * 0.4);
  const rawHeight = field.bbox.height ?? (isNormalized ? 0.04 : 24);

  const width = isNormalized ? rawWidth * pageWidth : rawWidth;
  const height = isNormalized ? rawHeight * pageHeight : rawHeight;

  const x = isNormalized
    ? Math.max(0, Math.min(1, field.bbox.x)) * pageWidth
    : Math.max(0, Math.min(pageWidth - width, field.bbox.x));

  const yFromTop = isNormalized
    ? Math.max(0, Math.min(1, field.bbox.y)) * pageHeight
    : Math.max(0, Math.min(pageHeight, field.bbox.y));

  const padding = Math.min(6, height * 0.25);
  const y = Math.min(
    pageHeight - padding,
    Math.max(padding, pageHeight - yFromTop - height + padding),
  );

  const fontSize = Math.min(16, Math.max(9, height * 0.6));
  const text =
    typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);

  page.drawText(text, {
    x: Math.min(pageWidth - 4, Math.max(2, x + 2)),
    y: Math.max(2, y),
    size: fontSize,
    color: rgb(0, 0, 0),
  });
}

export async function POST(request: NextRequest) {
  let payload: FillPayload;
  try {
    payload = (await request.json()) as FillPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload?.pdfBase64 || !payload.values) {
    return NextResponse.json(
      { error: "Missing pdfBase64 or values" },
      { status: 400 },
    );
  }

  try {
    const pdfBuffer = Buffer.from(payload.pdfBase64, "base64");
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
    });
    const form = pdfDoc.getForm();
    if (form.getFields().length > 0) {
      return NextResponse.json(
        {
          error:
            "This PDF already has fillable fields. Please fill it directly in your PDF reader. This app focuses on flat/image PDFs.",
        },
        { status: 400 },
      );
    }
    const availableFieldNames = form.getFields().map((f) => f.getName());
    const fieldKinds = new Map<string, PdfFieldKind>();
    for (const name of availableFieldNames) {
      fieldKinds.set(name, detectFieldKind(form, name));
    }
    const used = new Set<string>();
    const fieldsToFill =
      payload.fields && payload.fields.length > 0
        ? payload.fields
        : Object.keys(payload.values).map((name) => ({ name }));

    for (const field of fieldsToFill) {
      if (!field.name) continue;
      const desiredKinds: PdfFieldKind[] = [];
      if (field.type === "checkbox") desiredKinds.push("checkbox");
      if (field.type === "radio") desiredKinds.push("radio");
      if (field.type === "select") desiredKinds.push("dropdown", "optionlist");
      const candidates = availableFieldNames.filter((n) => !used.has(n));
      const resolvedName = resolveFieldName(
        field.name,
        candidates,
        fieldKinds,
        desiredKinds,
      );
      const value = payload.values[field.name];
      if (value === undefined || value === null) continue;
      let targetName = resolvedName;

      // Type-aware fallback: pick first unused field of expected kind.
      if (!targetName && desiredKinds.length) {
        targetName = availableFieldNames.find(
          (name) => !used.has(name) && desiredKinds.includes(fieldKinds.get(name) ?? "unknown"),
        );
      }

      if (!targetName) {
        if (field.bbox) {
          drawValueAtBBox(pdfDoc, field as DetectedField, value);
        } else {
          console.warn(
            `No matching PDF field for "${field.name}". Available: ${availableFieldNames.join(", ")}`,
          );
        }
        continue;
      }

      used.add(targetName);
      await applyValueToField(form, targetName, value);
    }

    const filledPdf = await pdfDoc.save();
    const base64 = Buffer.from(filledPdf).toString("base64");

    return NextResponse.json({ pdfBase64: base64 });
  } catch (error) {
    console.error("PDF fill error", error);
    return NextResponse.json(
      { error: "Failed to fill PDF" },
      { status: 500 },
    );
  }
}
