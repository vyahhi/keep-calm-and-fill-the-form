# PDF form → HTML form with Gemini

Simple Next.js app where you can upload any PDF, let Gemini 2.5 Flash detect fillable fields, render them as an HTML form, and download a filled PDF.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env.local` with your Gemini key:
   ```bash
   GEMINI_API_KEY=your_api_key_here
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```
4. Open [http://localhost:3000](http://localhost:3000)

## Flow

1. Upload a PDF or image on the left panel (images are auto-converted to PDF).
2. Click “Detect fields” to call the Gemini 2.5 Flash Lite API.
3. A web form is generated on the left; the PDF preview stays on the right.
4. Fill the form and submit to receive a downloadable filled PDF.
   - If the PDF is flat/image-like, Gemini’s bounding boxes are used to draw your answers back onto the PDF.
   - If the PDF already has native form fields, the app will tell you to fill it directly in your PDF reader (native forms are intentionally not handled here).
