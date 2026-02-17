import JSZip from 'jszip';

const BASE_URL = '/api/questions';
const S3_BASE = '/api/questions';
const QUESTION_FETCH_CONCURRENCY = 6;
const IMAGE_FETCH_CONCURRENCY = 10;

// Arabic label → HTML entity mapping
const LABEL_ENTITY_MAP: Record<string, string> = {
  'أ': '&#x623;',
  'ب': '&#x628;',
  'ج': '&#x62C;',
  'د': '&#x62F;',
  'هـ': '&#x647;',
  'ه': '&#x647;',
  'و': '&#x648;',
  'A': 'A',
  'B': 'B',
  'C': 'C',
  'D': 'D',
  'E': 'E',
  'F': 'F',
};

// ─── Types ────────────────────────────────────────
interface Choice {
  label: string;
  value: string;
  is_correct?: boolean;
}
interface GapKey {
  value: string;
  display_order: number;
  correct_order: number;
}
interface OrderingItem {
  value: string;
  display_order: number;
}
interface MatchingItems {
  A: { value: string; label: string; matches?: string }[];
  B: { value: string; label: string; matches?: string }[];
}
interface GmrqItems {
  A: Choice[];
  B: Choice[];
}
interface PuzzlePiece {
  display_order: number;
  correct_order: number;
  src: string;
  alt: string;
}

interface QuestionPart {
  n: number;
  type: string;
  stem: string;
  // MCQ / MRQ / Opinion
  choices?: Choice[];
  correct_answer?: unknown;
  acceptable_answers?: string[];
  // Gap
  gap_keys?: GapKey[];
  // Ordering
  direction?: string;
  items?: unknown;
  // Matching / GMRQ
  // items is reused (MatchingItems | GmrqItems)
  // Counting
  grid?: { rows: number; columns: number };
  // Puzzle
  rows?: string;
  columns?: string;
  pieces?: PuzzlePiece[];
  // Input
  ai_template_id?: string;
}

interface QuestionJSON {
  question_id: string;
  language_code: string;
  number_of_parts: number;
  content: {
    parts: QuestionPart[];
  };
}

// ─── Helper Functions ─────────────────────────────

function addLexicalClass(html: string, dir: string): string {
  // Process each <p> tag individually, handling existing attributes
  return html.replace(/<p(\s[^>]*)?\s*>/g, (fullMatch, attrs) => {
    const existingAttrs = attrs || '';

    // Check if class already exists
    let newAttrs = existingAttrs;
    if (!/class\s*=/.test(existingAttrs)) {
      newAttrs += ` class="LexicalTheme__paragraph"`;
    } else if (!/LexicalTheme__paragraph/.test(existingAttrs)) {
      // Add to existing class
      newAttrs = newAttrs.replace(/class\s*=\s*"([^"]*)"/, 'class="$1 LexicalTheme__paragraph"');
    }

    // Check if dir already exists
    if (!/dir\s*=/.test(newAttrs)) {
      newAttrs += ` dir="${dir}"`;
    }

    return `<p${newAttrs}>`;
  });
}

function getLabelEntity(label: string): string {
  return LABEL_ENTITY_MAP[label] || `${label}`;
}

function wrapChoiceValue(valueHtml: string, dir: string): string {
  const rawValue = String(valueHtml ?? '').trim();
  const valueWithLexicalClass = addLexicalClass(rawValue, dir).trim();
  const normalizedValue = /<\s*p\b/i.test(valueWithLexicalClass)
    ? valueWithLexicalClass
    : `<p class="LexicalTheme__paragraph" dir="${dir}">${valueWithLexicalClass}</p>`;

  return `<div class="choice-value" dir="${dir}">${normalizedValue}</div>`;
}

function renderChoiceItem(label: string, labelClass: string, valueHtml: string, dir: string): string {
  return `                <li class="">
                    <span class="${labelClass}">
                        ${label}
                    </span>
                    ${wrapChoiceValue(valueHtml, dir)}
                </li>`;
}

// ─── Renderers per question type ──────────────────

function renderStringAnswer(part: QuestionPart, dir: string): string {
  const answer = part.acceptable_answers?.[0] || '';
  return `
        <ul class="mcq_choices">
${renderChoiceItem('&#x623;', 'answered correct', answer, dir)}
        </ul>
`;
}

function renderMCQAnswer(part: QuestionPart, dir: string): string {
  if (!part.choices?.length) return '';
  const items = part.choices.map((choice) => {
    const entity = getLabelEntity(choice.label);
    const cls = choice.is_correct ? 'not_active answered correct' : 'not_active';
    return renderChoiceItem(entity, cls, choice.value, dir);
  }).join('\n');
  return `
    <ul class="mcq_choices">
${items}
    </ul>
`;
}

function renderMRQAnswer(part: QuestionPart, dir: string): string {
  // MRQ is like MCQ but multiple correct answers
  return renderMCQAnswer(part, dir);
}

function renderFRQAnswer(part: QuestionPart, dir: string): string {
  const answers = part.acceptable_answers || [];
  if (answers.length === 0) return '';
  const answerHTML = addLexicalClass(answers[0], dir);
  return `
        <div class="frq-answer">
                <div class="answered correct">${answerHTML}</div>
        </div>
`;
}

function renderInputAnswer(part: QuestionPart): string {
  const ca = part.correct_answer as { value: unknown; unit?: string | null } | undefined;
  if (!ca) return '';
  const val = ca.value !== undefined ? String(ca.value) : '';
  const unit = ca.unit || '';
  return `
        <div class="input-answer">
                <span class="answered correct">${val}${unit ? ' ' + unit : ''}</span>
        </div>
`;
}

function renderGapAnswer(part: QuestionPart, dir: string): string {
  if (!part.gap_keys?.length) return '';
  const sorted = [...part.gap_keys].sort((a, b) => a.correct_order - b.correct_order);
  const items = sorted.map((gapKey, index) =>
    renderChoiceItem(String(index + 1), 'answered correct', gapKey.value, dir)
  ).join('\n');
  return `
        <ul class="mcq_choices">
${items}
        </ul>
`;
}

function renderOrderingAnswer(part: QuestionPart, dir: string): string {
  const ca = part.correct_answer;
  if (!Array.isArray(ca)) return '';
  const items = (ca as string[]).map((value, index) =>
    renderChoiceItem(String(index + 1), 'answered correct', value, dir)
  ).join('\n');
  return `
        <ol class="mcq_choices">
${items}
        </ol>
`;
}

function renderMatchingAnswer(part: QuestionPart): string {
  const ca = part.correct_answer;
  if (!Array.isArray(ca)) return '';
  const pairs = ca as { A: string; B: string }[];
  const rows = pairs.map((pair) =>
    `            <tr>
                <td>${pair.A}</td>
                <td>↔</td>
                <td>${pair.B}</td>
            </tr>`
  ).join('\n');
  return `
        <table class="matching-answer">
${rows}
        </table>
`;
}

function renderGMRQAnswer(part: QuestionPart, dir: string): string {
  const items = part.items as GmrqItems | undefined;
  if (!items) return '';

  const renderGroup = (group: Choice[]) => {
    return group.map((choice) => {
      const cls = choice.is_correct ? 'not_active answered correct' : 'not_active';
      return renderChoiceItem(getLabelEntity(choice.label), cls, choice.value, dir);
    }).join('\n');
  };

  return `
        <div class="gmrq-group">
            <strong>Group A:</strong>
            <ul class="mcq_choices">
${renderGroup(items.A)}
            </ul>
            <strong>Group B:</strong>
            <ul class="mcq_choices">
${renderGroup(items.B)}
            </ul>
        </div>
`;
}

function renderCountingAnswer(part: QuestionPart): string {
  const ca = part.correct_answer;
  return `
        <div class="input-answer">
                <span class="answered correct">${ca}</span>
        </div>
`;
}

function renderOpinionAnswer(part: QuestionPart, dir: string): string {
  if (!part.choices?.length) return '';
  const items = part.choices.map((choice) =>
    renderChoiceItem(getLabelEntity(choice.label), 'not_active', choice.value, dir)
  ).join('\n');
  return `
    <ul class="mcq_choices">
${items}
    </ul>
`;
}

function renderPuzzleAnswer(part: QuestionPart): string {
  const ca = part.correct_answer as { src: string; alt: string } | undefined;
  if (!ca) return '';
  return `
        <div class="puzzle-answer">
            <img src="${ca.src}" alt="${ca.alt || 'Puzzle answer'}" style="max-width: 300px;" />
        </div>
`;
}

// ─── Main renderer ─────────────────────────────────

function renderAnswers(part: QuestionPart, dir: string): string {
  switch (part.type) {
    case 'string': return renderStringAnswer(part, dir);
    case 'mcq': return renderMCQAnswer(part, dir);
    case 'mrq': return renderMRQAnswer(part, dir);
    case 'frq': return renderFRQAnswer(part, dir);
    case 'input': return renderInputAnswer(part);
    case 'gap': return renderGapAnswer(part, dir);
    case 'ordering': return renderOrderingAnswer(part, dir);
    case 'matching': return renderMatchingAnswer(part);
    case 'gmrq': return renderGMRQAnswer(part, dir);
    case 'counting': return renderCountingAnswer(part);
    case 'opinion': return renderOpinionAnswer(part, dir);
    case 'puzzle': return renderPuzzleAnswer(part);
    default: return `<p style="color:#999;">Unsupported type: ${part.type}</p>`;
  }
}

function rewriteImagePaths(html: string, questionId: string): string {
  // Rewrite relative img src to images/{questionId}/{filename}
  return html.replace(/(<img[^>]*\ssrc\s*=\s*")([^"]*\.(?:svg|png|jpg|jpeg|gif|webp))(")/gi, (match, pre, src, post) => {
    // Skip absolute URLs
    if (/^https?:\/\//.test(src) || src.startsWith('images/')) return match;
    return `${pre}images/${questionId}/${src}${post}`;
  });
}

function collectImagePaths(html: string): string[] {
  const imgs: string[] = [];
  const regex = /src\s*=\s*"([^"]*\.(?:svg|png|jpg|jpeg|gif|webp))"/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (!/^https?:\/\//.test(m[1])) {
      imgs.push(m[1]);
    }
  }
  return imgs;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function resolveImageUrl(imgPath: string): string | null {
  const normalizedPath = imgPath.replace(/^\/+/, '');
  const parts = normalizedPath.split('/');
  if (parts.length < 3 || parts[0] !== 'images') {
    return null;
  }

  const questionId = parts[1];
  const filename = parts.slice(2).join('/');
  if (!questionId || !filename) {
    return null;
  }

  return `${S3_BASE}/${questionId}/${filename}`;
}

function generateQuestionHTML(question: QuestionJSON): string {
  const dir = question.language_code === 'ar' ? 'rtl' : 'ltr';
  const dirClass = `dir-${dir}`;
  const qId = question.question_id;
  const isMultiPart = question.number_of_parts > 1;
  const wrapperClass = isMultiPart ? 'multi-parts-question' : 'one-part-question';

  const partsHTML = question.content.parts.map((part) => {
    const stemHTML = rewriteImagePaths(addLexicalClass(part.stem, dir), qId);
    const answersHTML = rewriteImagePaths(renderAnswers(part, dir), qId);
    const partLabel = isMultiPart
      ? `\n                    <div class="part-number"><p>Part ${part.n}</p></div>` : '';

    return `                    ${partLabel}
                        <div class="question inline-displayed" data-partno="${part.n}" data-parttype="${part.type}">

            <div class="stem">
                ${stemHTML}
            </div>
            <div class="answers">
${answersHTML}
            </div>
        </div>`;
  }).join('\n\n');

  return `
            <div class="instance ${dirClass}" data-questionid="${qId}">
                <div class="${wrapperClass}">
                    <div class="question-number">
                        <p>Question (${qId})</p>
                    </div>
${partsHTML}




                </div>
            </div>`;
}

// ─── Public API ───────────────────────────────────

export interface ExportResult {
  blob: Blob;
  successCount: number;
  failedIds: string[];
  failedImagePaths: string[];
}

export async function generateExportHTML(
  questionIds: string[],
  onProgress?: (loaded: number, total: number, phase: string) => void
): Promise<ExportResult> {
  const failedIds: string[] = [];
  let processedQuestions = 0;
  const questionResults = await mapWithConcurrency(questionIds, QUESTION_FETCH_CONCURRENCY, async (id) => {
    try {
      const response = await fetch(`${BASE_URL}/${id}/${id}.json`);
      if (!response.ok) {
        console.warn(`Failed to fetch question ${id}: ${response.status}`);
        return { id, question: null as QuestionJSON | null };
      }
      const question = await response.json() as QuestionJSON;
      return { id, question };
    } catch (err) {
      console.warn(`Error fetching question ${id}:`, err);
      return { id, question: null as QuestionJSON | null };
    } finally {
      processedQuestions += 1;
      onProgress?.(processedQuestions, questionIds.length, 'questions');
    }
  });

  const questions: QuestionJSON[] = [];
  for (const result of questionResults) {
    if (result.question) {
      questions.push(result.question);
    } else {
      failedIds.push(result.id);
    }
  }

  const questionDivs = questions.map((q) => generateQuestionHTML(q)).join('\n');

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
            <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
            <head>
                <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
                <meta name="Author" content="Nagwa" />
                <meta name="application-name" content="Nagwa" />
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes" />
                <meta name="format-detection" content="telephone=no" />
                <meta property="og:image" content="https://contents.nagwa.com/content/images/nagwa-share.png">
                <link rel="icon" href="https://contents.nagwa.com/content/images/favicon.png" type="image/png" />
                <link href="https://contents.nagwa.com/content/styles/app-min.637857909358239378.css" rel="stylesheet" />
                <link href="https://contents.nagwa.com/content/styles/plyr-min.637845694981855899.css" rel="stylesheet" />

                <!-- KaTeX for math rendering -->
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" />
                <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"><\/script>

                <style>
                    /* ===== Blank-line / Gap Span ===== */
                    span[data-node-type="blank-line"] {
                        display: inline-block;
                        min-width: 80px;
                        border-bottom: 2px solid #333;
                        margin: 0 4px;
                        text-align: center;
                        vertical-align: baseline;
                    }
                    span[data-node-type="blank-line"][data-node-variation="gap"] {
                        min-width: 100px;
                        padding: 2px 8px;
                    }

                    /* ===== Math / LaTeX Spans ===== */
                    .LexicalTheme__math--inline,
                    .LexicalTheme__math-inline {
                        display: inline-block;
                        vertical-align: middle;
                        margin: 0 2px;
                    }
                    .LexicalTheme__math--block,
                    .LexicalTheme__math-block {
                        display: block;
                        text-align: center;
                        margin: 10px 0;
                    }

                    /* ===== Audio Wrapper Span ===== */
                    span.audio-wrapper,
                    span[data-node-type="audio"] {
                        display: inline-block;
                        vertical-align: middle;
                        margin: 4px 0;
                    }
                    span.audio-wrapper audio,
                    span[data-node-type="audio"] audio {
                        max-width: 300px;
                        height: 36px;
                    }

                    /* ===== RTL / LTR Text Direction Spans ===== */
                    .LexicalTheme__text-rtl {
                        direction: rtl;
                        unicode-bidi: embed;
                        text-align: right;
                    }
                    .LexicalTheme__text-ltr {
                        direction: ltr;
                        unicode-bidi: embed;
                        text-align: left;
                    }
                    span[dir="rtl"] {
                        direction: rtl;
                        unicode-bidi: embed;
                    }
                    span[dir="ltr"] {
                        direction: ltr;
                        unicode-bidi: embed;
                    }

                    /* ===== Formatting / Pre-wrap Spans ===== */
                    span[style*="white-space: pre-wrap"] {
                        white-space: pre-wrap !important;
                    }

                    /* ===== Editor Keywords (should not appear, but hide just in case) ===== */
                    .editor-keyword {
                        display: none !important;
                    }

                    /* ===== LexicalTheme Paragraph ===== */
                    .LexicalTheme__paragraph {
                        margin: 0;
                        padding: 0;
                        line-height: 1.8;
                    }

                    /* ===== Direction Classes ===== */
                    .dir-rtl {
                        direction: rtl;
                        text-align: right;
                    }
                    .dir-ltr {
                        direction: ltr;
                        text-align: left;
                    }

                    /* ===== MCQ / Choices Styling ===== */
                    .mcq_choices {
                        list-style: none;
                        padding: 0;
                        margin: 15px 0;
                    }
                    .mcq_choices li {
                        display: flex !important;
                        align-items: flex-start !important;
                        justify-content: flex-start !important;
                        width: 100% !important;
                        margin-bottom: 12px;
                        gap: 12px;
                    }
                    .mcq_choices li > span {
                        flex: 0 0 auto;
                        min-width: 2.2em;
                        text-align: center;
                        overflow: visible !important;
                        float: none !important;
                        position: static !important;
                        margin: 0 !important;
                        left: auto !important;
                        right: auto !important;
                    }
                    .mcq_choices li .choice-value {
                        flex: 1 1 auto;
                        min-width: 0;
                    }
                    .mcq_choices li .choice-value p {
                        margin: 0 !important;
                        white-space: normal;
                        overflow-wrap: anywhere;
                    }
                    .mcq_choices li p {
                        margin: 0 !important;
                    }
                    .dir-rtl .mcq_choices li {
                        flex-direction: row !important;
                        justify-content: flex-start !important;
                        direction: rtl !important;
                        text-align: right;
                    }
                    .dir-ltr .mcq_choices li {
                        flex-direction: row !important;
                        justify-content: flex-start !important;
                        direction: ltr !important;
                        text-align: left;
                    }
                    .dir-rtl .mcq_choices li .choice-value,
                    .dir-rtl .mcq_choices li .choice-value * {
                        direction: rtl;
                        text-align: right;
                    }
                    .dir-ltr .mcq_choices li .choice-value,
                    .dir-ltr .mcq_choices li .choice-value * {
                        direction: ltr;
                        text-align: left;
                    }
                </style>
            </head>
            <body>
<div class="instances instances--instances-preview" id="questionList">
${questionDivs}
</div>
<script>
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('math-field').forEach(function(mf) {
        var latex = mf.getAttribute('value') || mf.textContent || '';
        if (!latex.trim()) return;
        var span = document.createElement('span');
        span.className = 'katex-rendered';
        try {
            katex.render(latex, span, {
                throwOnError: false,
                displayMode: mf.closest('[data-node-variation="block"]') !== null ||
                              mf.closest('.LexicalTheme__math--block') !== null ||
                              mf.closest('.LexicalTheme__math-block') !== null
            });
        } catch(e) {
            span.textContent = latex;
        }
        mf.parentNode.replaceChild(span, mf);
    });
});
<\/script>
</body></html>
  `;

  // Phase 2: Collect all image paths from the generated HTML
  const imagePaths = [...new Set(collectImagePaths(html))];
  const failedImagePathSet = new Set<string>();
  const zip = new JSZip();
  zip.file('Questions_Export.html', html);

  // Phase 3: Download images and add to ZIP
  if (imagePaths.length > 0) {
    let processedImages = 0;
    await mapWithConcurrency(imagePaths, IMAGE_FETCH_CONCURRENCY, async (imgPath) => {
      const imageUrl = resolveImageUrl(imgPath);
      if (!imageUrl) {
        failedImagePathSet.add(imgPath);
        processedImages += 1;
        onProgress?.(processedImages, imagePaths.length, 'images');
        return null;
      }

      try {
        const response = await fetch(imageUrl);
        if (response.ok) {
          const blob = await response.blob();
          zip.file(imgPath, blob);
        } else {
          failedImagePathSet.add(imgPath);
          console.warn(`Failed to download image ${imageUrl}: ${response.status}`);
        }
      } catch (err) {
        failedImagePathSet.add(imgPath);
        console.warn(`Error downloading image ${imageUrl}:`, err);
      } finally {
        processedImages += 1;
        onProgress?.(processedImages, imagePaths.length, 'images');
      }
      return null;
    });
  }

  const blob = await zip.generateAsync({ type: 'blob' });

  return {
    blob,
    successCount: questions.length,
    failedIds,
    failedImagePaths: [...failedImagePathSet],
  };
}
