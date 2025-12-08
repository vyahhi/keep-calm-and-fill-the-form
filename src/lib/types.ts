export type FieldType =
  | "text"
  | "email"
  | "number"
  | "date"
  | "checkbox"
  | "radio"
  | "select";

export interface FieldBBox {
  page: number; // zero-based page index
  x: number; // normalized [0,1] from left
  y: number; // normalized [0,1] from top
  width?: number; // normalized [0,1]
  height?: number; // normalized [0,1]
}

export interface DetectedField {
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
  bbox?: FieldBBox;
  fontScale?: number;
}

export interface DetectionResponse {
  fields: DetectedField[];
  title?: string;
}

export interface FillPayload {
  pdfBase64: string;
  values: Record<string, string | boolean>;
  fields?: DetectedField[];
}
