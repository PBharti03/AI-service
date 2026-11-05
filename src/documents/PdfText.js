// PDF text extraction. Separate entry point ("@b2y/ai-service/documents/pdf") so the optional unpdf peer
// dependency is only loaded by applications that add PDF documents. Needs Node.js 22 or later.
import { extractText, getDocumentProxy } from "unpdf";
import { AiServiceError } from "../core/Errors.js";
import { ErrorCodes } from "../core/Errors.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT_CHARS = 2_000_000;

/**
 * Extracts the text of a PDF, page by page (pages separated by a blank line). Scanned PDFs without a text
 * layer produce no text and are refused: they would need OCR.
 * @param {Uint8Array | ArrayBuffer} data
 * @returns {Promise<{ text: string, pages: number }>}
 */
export async function extractPdfText(data, { maxBytes = MAX_PDF_BYTES, maxPages = MAX_PDF_PAGES } = {}) {
  // A copy: the parser may transfer (detach) the buffer it is given.
  const bytes = new Uint8Array(data);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new AiServiceError(ErrorCodes.INPUT_INVALID, "PDF is empty or too large", { details: { limitBytes: maxBytes } });
  }
  // "%PDF-" header: refuse other files early instead of handing them to the parser.
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    throw new AiServiceError(ErrorCodes.INPUT_INVALID, "File is not a PDF");
  }

  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (error) {
    // The parser's message can quote file content, so only a generic reason is kept.
    throw new AiServiceError(ErrorCodes.INPUT_INVALID, "PDF could not be read", { cause: error });
  }
  try {
    if (pdf.numPages > maxPages) {
      throw new AiServiceError(ErrorCodes.INPUT_INVALID, "PDF has too many pages", { details: { limitPages: maxPages } });
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((page) => String(page).trim()).filter((page) => page !== "");
    const joined = pages.join("\n\n").slice(0, MAX_PDF_TEXT_CHARS);
    if (joined.trim() === "") {
      throw new AiServiceError(ErrorCodes.INPUT_INVALID, "PDF has no text layer (scanned images need OCR)");
    }
    return { text: joined, pages: pdf.numPages };
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError(ErrorCodes.INPUT_INVALID, "PDF text could not be extracted", { cause: error });
  } finally {
    await pdf.destroy?.();
  }
}
