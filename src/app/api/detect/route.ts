import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PDFDocument } from "pdf-lib";
import { DetectedField } from "@/lib/types";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `
You are mapping form fields in a PDF (including flat/image-only PDFs) for HTML rendering.
Respond with JSON only, no prose or markdown fencing.
Return an object with keys:
- title: short form title inferred from the document (string)
- fields: array of objects with keys:
  - name: unique id matching the PDF field name when possible (use readable slugs otherwise)
  - label: short user-facing label
  - type: one of text,email,number,date,checkbox,radio,select
  - placeholder: optional short hint
  - options: only for radio/select (array of strings)
  - bbox: optional object { page, x, y, width, height } with normalized coordinates (0-1, origin top-left)

Prefer existing AcroForm names if present, keep array short (max 30 items).
If you are unsure about a field, omit it.
`.trim();

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function resolveFieldName(requested: string, available: string[]) {
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

  const contains = available.find((name) =>
    normalize(name).includes(normalizedRequested),
  );
  if (contains) return contains;

  return null;
}

function detectFieldKind(
  form: ReturnType<PDFDocument["getForm"]>,
  name: string,
): "text" | "checkbox" | "radio" | "dropdown" | "optionlist" | "unknown" {
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

function parseResponse(raw: string): { fields: DetectedField[]; title?: string } {
  const jsonBlock = raw.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const allowedTypes: DetectedField["type"][] = [
    "text",
    "email",
    "number",
    "date",
    "checkbox",
    "radio",
    "select",
  ];
  try {
    const parsed = JSON.parse(jsonBlock);
    const payload = Array.isArray(parsed) ? { fields: parsed } : parsed;
    const fieldsRaw = Array.isArray(payload?.fields) ? payload.fields : [];
    const fields = fieldsRaw
      .map((item) => ({
        name: String(item.name ?? "").trim(),
        label: String(item.label ?? item.name ?? "").trim(),
        type: allowedTypes.includes(
          String(item.type ?? "").toLowerCase() as DetectedField["type"],
        )
          ? (String(item.type).toLowerCase() as DetectedField["type"])
          : "text",
        placeholder: item.placeholder ? String(item.placeholder) : undefined,
        options: Array.isArray(item.options)
          ? item.options.map((opt: unknown) => String(opt))
          : undefined,
        bbox:
          item.bbox &&
          typeof item.bbox === "object" &&
          typeof item.bbox.page === "number" &&
          typeof item.bbox.x === "number" &&
          typeof item.bbox.y === "number"
            ? {
                page: item.bbox.page,
                x: item.bbox.x,
                y: item.bbox.y,
                width:
                  typeof item.bbox.width === "number"
                    ? item.bbox.width
                    : undefined,
                height:
                  typeof item.bbox.height === "number"
                    ? item.bbox.height
                    : undefined,
              }
            : undefined,
      }))
      .filter((f) => f.name && f.label) as DetectedField[];

    const title =
      typeof payload?.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : undefined;

    return { fields, title };
  } catch (error) {
    console.error("Failed to parse Gemini response", error, raw);
    return { fields: [], title: undefined };
  }
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing GEMINI_API_KEY" },
      { status: 500 },
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
  }

  const pdfBuffer = Buffer.from(await file.arrayBuffer());
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const existingFormFields = pdfDoc.getForm().getFields();
  if (existingFormFields.length > 0) {
    return NextResponse.json(
      {
        error:
          "This PDF already has fillable fields. Please fill it directly in your PDF reader. This app focuses on flat/image PDFs.",
      },
      { status: 400 },
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  try {
    const result = await model.generateContent([
      {
        inlineData: {
          data: pdfBuffer.toString("base64"),
          mimeType: "application/pdf",
        },
      },
      {
        text: SYSTEM_PROMPT,
      },
    ]);

    const text = result.response.text().trim();
    const parsed = parseResponse(text);
    const { fields } = parsed;

    // Enrich detected fields with actual PDF form metadata (options/types)
    if (fields.length) {
      const form = pdfDoc.getForm();
      const pdfFieldNames = form.getFields().map((f) => f.getName());

      for (const field of fields) {
        const resolved = resolveFieldName(field.name, pdfFieldNames);
        if (!resolved) continue;
        const kind = detectFieldKind(form, resolved);
        if (kind === "radio") field.type = "radio";
        if (kind === "checkbox") field.type = "checkbox";
        if (kind === "dropdown" || kind === "optionlist") field.type = "select";

        let options: string[] | undefined;
        try {
          if (kind === "dropdown") options = form.getDropdown(resolved).getOptions();
          if (kind === "optionlist") options = form.getOptionList(resolved).getOptions();
          if (kind === "radio") options = form.getRadioGroup(resolved).getOptions();
        } catch {
          // ignore option fetch issues
        }

        if (options && options.length) {
          if (!field.options || options.length > field.options.length) {
            field.options = options;
          }
        }
      }
    }

    if (fields.length) {
      console.log(
        "Detected fields:",
        fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          options: f.options,
          bbox: f.bbox,
        })),
      );
    }

    return NextResponse.json({ fields, title: parsed.title });
  } catch (error) {
    console.error("Gemini detection error", error);
    return NextResponse.json(
      { error: "Failed to detect fields from PDF" },
      { status: 500 },
    );
  }
}
