import JSZip from 'jszip';

const BASE_URL = '/api/questions';
const S3_BASE = '/api/questions';

// Arabic label → HTML entity mapping
const LABEL_ENTITY_MAP: Record<string, string> = {
  'أ': '&#x623;',
  'ب': '&#x628;',
  'ج': '&#x62C;',
  'د': '&#x62F;',
  'هـ': '&#x647;',
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

// ─── Renderers per question type ──────────────────

function renderStringAnswer(part: QuestionPart): string {
  const answer = part.acceptable_answers?.[0] || '';
  return `
        <ul class="mcq_choices">
                <li class="">
                    <span class="answered correct">
                        &#x623;
                    </span>${answer}
                </li>
        </ul>
`;
}

function renderMCQAnswer(part: QuestionPart, dir: string): string {
  if (!part.choices?.length) return '';
  const items = part.choices.map((c) => {
    const entity = getLabelEntity(c.label);
    const cls = c.is_correct ? 'not_active answered correct' : 'not_active';
    const val = addLexicalClass(c.value, dir);
    return `                <li class="">
                    <span class="${cls}">
                        ${entity}
                    </span>${val}
                </li>`;
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
  // Show the gap keys in correct order
  const sorted = [...part.gap_keys].sort((a, b) => a.correct_order - b.correct_order);
  const items = sorted.map((gk, i) =>
    `                <li class="">
                    <span class="answered correct">${i + 1}</span>${gk.value}
                </li>`
  ).join('\n');
  return `
        <ul class="mcq_choices">
${items}
        </ul>
`;
}

function renderOrderingAnswer(part: QuestionPart): string {
  const ca = part.correct_answer;
  if (!Array.isArray(ca)) return '';
  const items = (ca as string[]).map((val, i) =>
    `                <li class="">
                    <span class="answered correct">${i + 1}</span>${val}
                </li>`
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
  // GMRQ has items.A and items.B, show correct ones from each group
  const items = part.items as GmrqItems | undefined;
  if (!items) return '';

  const renderGroup = (group: Choice[], label: string) => {
    return group.map((c) => {
      const cls = c.is_correct ? 'not_active answered correct' : 'not_active';
      const val = addLexicalClass(c.value, dir);
      return `                <li class="">
                    <span class="${cls}">${getLabelEntity(c.label)}</span>${val}
                </li>`;
    }).join('\n');
  };

  return `
        <div class="gmrq-group">
            <strong>Group A:</strong>
            <ul class="mcq_choices">
${renderGroup(items.A, 'A')}
            </ul>
            <strong>Group B:</strong>
            <ul class="mcq_choices">
${renderGroup(items.B, 'B')}
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
  // Opinion questions show choices without correct/incorrect
  if (!part.choices?.length) return '';
  const items = part.choices.map((c) => {
    const entity = getLabelEntity(c.label);
    return `                <li class="">
                    <span class="not_active">${entity}</span>${c.value}
                </li>`;
  }).join('\n');
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
    case 'string': return renderStringAnswer(part);
    case 'mcq': return renderMCQAnswer(part, dir);
    case 'mrq': return renderMRQAnswer(part, dir);
    case 'frq': return renderFRQAnswer(part, dir);
    case 'input': return renderInputAnswer(part);
    case 'gap': return renderGapAnswer(part, dir);
    case 'ordering': return renderOrderingAnswer(part);
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

function generateQuestionHTML(question: QuestionJSON): string {
  const dir = question.language_code === 'ar' ? 'rtl' : 'ltr';
  const dirClass = `dir-${dir}`;
  const qId = question.question_id;
  const isMultiPart = question.number_of_parts > 1;
  const wrapperClass = isMultiPart ? 'multi-parts-question' : 'one-part-question';

  const partsHTML = question.content.parts.map((part) => {
    const stemHTML = rewriteImagePaths(addLexicalClass(part.stem, dir), qId);
    const answersHTML = renderAnswers(part, dir);
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
}

export async function generateExportHTML(
  questionIds: string[],
  onProgress?: (loaded: number, total: number, phase: string) => void
): Promise<ExportResult> {
  const questions: QuestionJSON[] = [];
  const failedIds: string[] = [];

  // Phase 1: Fetch question JSON
  for (let i = 0; i < questionIds.length; i++) {
    const id = questionIds[i];
    const basePath = `${BASE_URL}/${id}`;
    try {
      const response = await fetch(`${basePath}/${id}.json`);
      if (!response.ok) {
        console.warn(`Failed to fetch question ${id}: ${response.status}`);
        failedIds.push(id);
        onProgress?.(i + 1, questionIds.length, 'questions');
        continue;
      }
      const json: QuestionJSON = await response.json();
      questions.push(json);
    } catch (err) {
      console.warn(`Error fetching question ${id}:`, err);
      failedIds.push(id);
    }
    onProgress?.(i + 1, questionIds.length, 'questions');
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
  const imagePaths = collectImagePaths(html);
  const zip = new JSZip();
  zip.file('Questions_Export.html', html);

  // Phase 3: Download images and add to ZIP
  if (imagePaths.length > 0) {
    let downloaded = 0;
    const imagePromises = imagePaths.map(async (imgPath) => {
      // imgPath is like "images/217151435842/217151435842.01.svg"
      const parts = imgPath.split('/');
      const questionId = parts[1];
      const filename = parts[2];
      const imageUrl = `${S3_BASE}/${questionId}/${filename}`;
      try {
        const resp = await fetch(imageUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          zip.file(imgPath, blob);
        } else {
          console.warn(`Failed to download image ${imageUrl}: ${resp.status}`);
        }
      } catch (err) {
        console.warn(`Error downloading image ${imageUrl}:`, err);
      }
      downloaded++;
      onProgress?.(downloaded, imagePaths.length, 'images');
    });
    await Promise.all(imagePromises);
  }

  const blob = await zip.generateAsync({ type: 'blob' });

  return {
    blob,
    successCount: questions.length,
    failedIds,
  };
}
