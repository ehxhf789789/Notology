[◀ Calendar](EN-Calendar) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Templates ▶](EN-Templates)

---

# <img src="images/icons/file-scan.png" width="24" height="24"> Document Preview

View a wide variety of files directly inside Notology. Preview PDFs, images, office documents, code files, and more — without needing a separate program.

---

## Supported File Types

| Category | Extensions | Preview Method |
|----------|-----------|----------------|
| **PDF** | `.pdf` | Built-in viewer (iframe) |
| **Image** | `.png` `.jpg` `.gif` `.svg` `.webp` `.bmp` | Built-in image viewer |
| **Modern Office** | `.docx` `.xlsx` `.pptx` `.hwpx` | Converted to PDF via LibreOffice, then displayed |
| **Legacy Office** | `.doc` `.ppt` `.xls` `.hwp` | Opens directly in the default app |
| **Code files** | `.js` `.py` `.ts` `.css` etc. | Syntax-highlighted viewer |

> 📸 **GIF placeholder** — `images/docpreview-file-types.gif`
>
> **Shot**: Clicking several file types (PDF, image, DOCX) one after another to show the different preview modes
> **Steps**: ① Click a PDF file → PDF viewer is displayed → ② Click an image file → image viewer is displayed → ③ Click a DOCX file → converted and shown in the PDF viewer
> **Screen area**: Full screen (file selection in sidebar + hover window preview)
> **Highlight**: The different viewer screens that appear depending on the file type
> **Duration**: 8~12s

---

## PDF Preview

PDF files open directly inside Notology. Basic PDF viewer features like scrolling, zooming, and page navigation are supported.

- Click a PDF from a wikilink, attachment, or the sidebar to open it in a hover window
- No separate PDF viewer program is needed

> 📸 **GIF placeholder** — `images/docpreview-pdf.gif`
>
> **Shot**: Clicking a PDF file in the sidebar to open it in a hover window and scrolling through it
> **Steps**: ① Click a PDF file in the sidebar → ② The PDF appears in a hover window → ③ Scroll with the mouse to navigate pages
> **Screen area**: Full screen (sidebar click + PDF viewer in the hover window)
> **Highlight**: The PDF rendering directly inside the app
> **Duration**: 5~8s

---

## Image Preview

Image files are displayed directly in the built-in viewer.

- **Supported formats**: PNG, JPG/JPEG, GIF, SVG, WebP, BMP
- View images instantly in a hover window

> 📸 **GIF placeholder** — `images/docpreview-image.gif`
>
> **Shot**: Clicking an image file to display it in a hover window
> **Steps**: ① Click an image file in the sidebar → ② The image appears in a hover window
> **Screen area**: Full screen (sidebar click + image viewer in the hover window)
> **Highlight**: The image rendering cleanly inside the viewer
> **Duration**: 3~5s

---

## Office Document Preview

Modern office documents (`.docx`, `.xlsx`, `.pptx`, `.hwpx`) are converted to PDF via **LibreOffice** before being displayed.

### Conversion Process

| Step | Description |
|------|-------------|
| 1 | Click a document and a **converting** spinner appears |
| 2 | LibreOffice converts the file to PDF in the background |
| 3 | Once conversion is complete, the PDF is displayed on screen |

### Caching

- Once a document has been converted, it is **saved in a cache** and displays instantly next time
- If the original file is modified (modification time changes), it is automatically re-converted
- Cache location: `%LOCALAPPDATA%\Notology\preview_cache\`

> 📸 **GIF placeholder** — `images/docpreview-office.gif`
>
> **Shot**: Clicking a DOCX file showing the conversion spinner, then the converted PDF appearing
> **Steps**: ① Click a DOCX file → ② "Converting" spinner is displayed → ③ Spinner disappears and the converted PDF appears on screen → ④ Scroll to view content
> **Screen area**: Entire hover window (spinner → PDF transition)
> **Highlight**: The moment the spinner transitions to the PDF
> **Duration**: 5~8s

### Legacy Formats

Older formats like `.doc`, `.ppt`, `.xls`, and `.hwp` **open directly in their default program** without conversion.

---

## LibreOffice Requirement

To use office document preview, **LibreOffice** must be installed on your computer.

| Situation | Behavior |
|-----------|----------|
| LibreOffice **installed** | Automatically detected — document conversion works |
| LibreOffice **not installed** | An info message appears along with an **"Open in app"** button |

- Notology automatically detects the LibreOffice installation path (by scanning Program Files folders)
- Even without LibreOffice, you can use the **"Open in app"** button to open files in their default program

> 📸 **GIF placeholder** — `images/docpreview-no-libreoffice.gif`
>
> **Shot**: Opening an office document when LibreOffice is not installed, showing the info message and "Open in app" button
> **Steps**: ① Click a DOCX file → ② "LibreOffice not installed" info message appears → ③ Click the "Open in app" button → ④ The file opens in the default program (e.g., MS Word)
> **Screen area**: Entire hover window (info message + button)
> **Highlight**: The info message content and the "Open in app" button location
> **Duration**: 5~8s

> **💡 Tip**: LibreOffice is a free, open-source program. You can download it from [libreoffice.org](https://www.libreoffice.org/).

---

## Code File Preview

Code files are displayed in a **syntax-highlighted viewer**. Keywords, strings, comments, and other elements are color-coded for easy reading.

> 📸 **GIF placeholder** — `images/docpreview-code.gif`
>
> **Shot**: Clicking a code file (.js or .py) to display the syntax-highlighted code viewer
> **Steps**: ① Click a code file in the sidebar → ② Syntax-highlighted code appears in the hover window → ③ Scroll to view the code
> **Screen area**: Full screen (sidebar click + code viewer in the hover window)
> **Highlight**: Keywords, strings, and comments displayed in different colors (syntax highlighting)
> **Duration**: 3~5s

---

## Ways to Open a Preview

Document previews can be started from several places.

| Method | Description |
|--------|-------------|
| **Attachment click** | Click an attachment link inside a note |
| **Sidebar** | Click a file in the sidebar |
| **Wikilink** | Click a `[[filename]]` wikilink |
| **Search results** | Click a file from search results |
| **Canvas** | Double-click a file node on the canvas |

---

[◀ Calendar](EN-Calendar) · [<img src="images/icons/home.png" width="16" height="16"> Home](Home) · [Templates ▶](EN-Templates)
