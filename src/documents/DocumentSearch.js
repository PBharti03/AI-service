/**
 * Keyword search over an application's documents (BM25), in plain JavaScript with no external service.
 * Documents are split into overlapping passages; a question is matched against the passages' words.
 * The index is a plain JSON object, so an application can store it anywhere (see FolderDocumentStore).
 */

const STOPWORDS = new Set(
  `a about above after again all am an and any are as at be been before being below between both but by can could did do
does doing down during each few for from further had has have having he her here hers him his how i if in into is it its
itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such
than that the their them then there these they this those through to too under until up very was we were what when where
which while who whom why will with would you your yours tell please give show know want need get let us also may might
must shall`.split(/\s+/),
);

/** Lower-case word stems: accents removed, stopwords dropped, plural and -ing/-ed endings trimmed. */
export function tokenize(text) {
  const words = String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  const tokens = [];
  for (const word of words) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    tokens.push(stem(word));
  }
  return tokens;
}

function stem(word) {
  if (/^\d+$/.test(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/**
 * Splits text into passages of at most maxChars, at paragraph and sentence boundaries, each starting with
 * the end of the previous passage (overlap) so an answer that spans a boundary is still found.
 * @returns {string[]}
 */
export function splitIntoPassages(text, { maxChars = 1200, overlapChars = 200 } = {}) {
  const paragraphs = String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      pieces.push(paragraph);
      continue;
    }
    // Long paragraph: split at sentence ends, and hard-split anything still too long.
    let current = "";
    for (const sentence of paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [paragraph]) {
      for (let start = 0; start < sentence.length; start += maxChars) {
        const part = sentence.slice(start, start + maxChars);
        if ((current + part).length > maxChars && current !== "") {
          pieces.push(current.trim());
          current = "";
        }
        current += part;
      }
    }
    if (current.trim() !== "") pieces.push(current.trim());
  }

  const passages = [];
  let current = "";
  for (const piece of pieces) {
    if ((current + " " + piece).trim().length > maxChars && current !== "") {
      passages.push(current);
      const tail = current.slice(-overlapChars);
      current = `${tail.slice(tail.indexOf(" ") + 1)} ${piece}`.trim();
    } else {
      current = `${current} ${piece}`.trim();
    }
  }
  if (current !== "") passages.push(current);
  return passages;
}

/**
 * @typedef {Object} IndexedDocument
 * @property {string} id
 * @property {string} title
 * @property {string} type - policy, privacy, terms, faq, questionnaire, guide or other.
 * @property {string} text
 * @property {string} [fileName]
 * @property {string} [addedAt]
 */

/**
 * @typedef {Object} SearchIndex
 * @property {1} version
 * @property {string} builtAt
 * @property {{ id: string, title: string, type: string, fileName?: string, addedAt?: string, passages: number }[]} documents
 * @property {{ documentId: string, text: string, terms: Record<string, number>, length: number }[]} passages
 * @property {Record<string, number>} documentFrequency - In how many passages each term appears.
 * @property {number} averageLength
 */

/**
 * Builds the search index for one application's documents.
 * @param {IndexedDocument[]} documents
 * @returns {SearchIndex}
 */
export function buildSearchIndex(documents, options = {}) {
  const passages = [];
  const indexedDocuments = [];
  for (const document of documents) {
    const texts = splitIntoPassages(document.text, options);
    for (const text of texts) {
      const terms = {};
      const tokens = tokenize(`${document.title} ${text}`);
      for (const token of tokens) terms[token] = (terms[token] ?? 0) + 1;
      passages.push({ documentId: document.id, text, terms, length: tokens.length });
    }
    indexedDocuments.push({
      id: document.id,
      title: document.title,
      type: document.type,
      ...(document.fileName ? { fileName: document.fileName } : {}),
      ...(document.addedAt ? { addedAt: document.addedAt } : {}),
      passages: texts.length,
    });
  }
  const documentFrequency = {};
  for (const passage of passages)
    for (const term of Object.keys(passage.terms)) documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
  const averageLength = passages.length === 0 ? 0 : passages.reduce((sum, passage) => sum + passage.length, 0) / passages.length;
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    documents: indexedDocuments,
    passages,
    documentFrequency,
    averageLength,
  };
}

/**
 * @typedef {Object} SearchHit
 * @property {string} documentId
 * @property {string} title
 * @property {string} type
 * @property {string} text
 * @property {number} score
 * @property {number} coverage - Share of the question's distinct words found in the passage (0-1).
 */

/**
 * Best passages for a question (BM25). Passages must contain at least minCoverage of the question's
 * distinct words; a question with no searchable words returns nothing.
 * @param {SearchIndex} index
 * @param {string} question
 * @returns {SearchHit[]}
 */
export function searchIndex(index, question, { limit = 5, minCoverage = 0.5, k1 = 1.5, b = 0.75 } = {}) {
  const queryTerms = [...new Set(tokenize(question))];
  if (queryTerms.length === 0 || !index || index.passages.length === 0) return [];
  const count = index.passages.length;
  const titles = new Map(index.documents.map((document) => [document.id, document]));
  const hits = [];
  for (const passage of index.passages) {
    let score = 0;
    let matched = 0;
    for (const term of queryTerms) {
      const frequency = passage.terms[term];
      if (!frequency) continue;
      matched += 1;
      const df = index.documentFrequency[term] ?? 0;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      score += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * passage.length) / (index.averageLength || 1)));
    }
    const coverage = matched / queryTerms.length;
    if (matched === 0 || coverage < minCoverage) continue;
    const document = titles.get(passage.documentId);
    hits.push({
      documentId: passage.documentId,
      title: document?.title ?? "",
      type: document?.type ?? "other",
      text: passage.text,
      score,
      coverage,
    });
  }
  return hits.sort((a, b) => b.coverage - a.coverage || b.score - a.score).slice(0, limit);
}
