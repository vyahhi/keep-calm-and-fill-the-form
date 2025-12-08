# Keep Calm and Fill the Form

Upload any PDF/image form, auto-detect fields via Gemini, edit them, and download the overlaid PDF with live preview and per-field nudges.

## Quick start
1) `npm install`
2) Add `.env.local`:
   ```
   GEMINI_API_KEY=your_key
   GEMINI_MODEL=gemini-2.5-flash-lite
   ```
3) `npm run dev` then open http://localhost:3000

## Flow
- Upload PDF/image (images auto-convert to PDF); native AcroForms are rejected with a message.
- Fields are detected; adjust each field’s position/size with inline ↑ ← → ↓ + – controls.
- Right panel shows the live filled preview; use “Download⬇” to save the overlaid PDF.
