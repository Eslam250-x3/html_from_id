const BASE_URL = 'https://s3.us-east-1.amazonaws.com/beta-qms.nagwa.com/questions';

// Arabic label → HTML entity mapping
const LABEL_ENTITY_MAP: Record<string, string> = {
  'أ': '&#x623;',
  'ب': '&#x628;',
  'ج': '&#x62C;',
  'د': '&#x62F;',
  'هـ': '&#x647;',
  'و': '&#x648;',
};

interface QuestionPart {
  n: number;
  type: string;
  stem: string;
  choices?: {
    label: string;
    value: string;
    is_correct: boolean;
  }[];
  acceptable_answers?: string[];
  correct_answer?: {
    label: string;
    value: string;
  };
  explanation?: string | null;
}

interface QuestionJSON {
  question_id: string;
  language_code: string;
  content: {
    parts: QuestionPart[];
  };
}

function wrapStemWithLexical(stem: string, dir: string): string {
  // The stem from JSON already has <p> tags with styles
  // We need to add the LexicalTheme__paragraph class and dir attribute
  return stem.replace(
    /<p(?=[\s>])/g,
    `<p class="LexicalTheme__paragraph" dir="${dir}"`
  );
}

function getLabelEntity(label: string): string {
  return LABEL_ENTITY_MAP[label] || label;
}

function generateStringAnswerHTML(acceptableAnswers: string[]): string {
  const answer = acceptableAnswers[0] || '';
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

function generateMCQAnswerHTML(choices: QuestionPart['choices'], dir: string): string {
  if (!choices || choices.length === 0) return '';

  const choicesHTML = choices.map((choice) => {
    const entity = getLabelEntity(choice.label);
    const spanClass = choice.is_correct
      ? 'not_active answered correct'
      : 'not_active';

    // Add LexicalTheme__paragraph class to choice value <p> tags
    const choiceValue = choice.value.replace(
      /<p(?=[\s>])/g,
      `<p class="LexicalTheme__paragraph" dir="${dir}"`
    );

    return `            <li class="">
                    <span class="${spanClass}">
                        ${entity}
                    </span>${choiceValue}
                </li>`;
  }).join('\n');

  return `
    <ul class="mcq_choices">
${choicesHTML}
    </ul>
`;
}

function generateQuestionHTML(question: QuestionJSON): string {
  const dir = question.language_code === 'ar' ? 'rtl' : 'ltr';
  const dirClass = `dir-${dir}`;
  const questionId = question.question_id;

  const partsHTML = question.content.parts.map((part) => {
    const stemHTML = wrapStemWithLexical(part.stem, dir);

    let answersHTML = '';
    if (part.type === 'string' && part.acceptable_answers) {
      answersHTML = generateStringAnswerHTML(part.acceptable_answers);
    } else if (part.type === 'mcq' && part.choices) {
      answersHTML = generateMCQAnswerHTML(part.choices, dir);
    }

    return `            <div class="question inline-displayed" data-partno="${part.n}" data-parttype="${part.type}">

            <div class="stem">
                ${stemHTML}
            </div>
            <div class="answers">
${answersHTML}
            </div>
        </div>`;
  }).join('\n\n');

  return `
            <div class="instance ${dirClass}" data-questionid="${questionId}">
                <div class="one-part-question">
                    <div class="question-number">
                        <p>Question (${questionId})</p>
                    </div>
                        ${partsHTML}




                </div>
            </div>`;
}

export async function generateExportHTML(
  questionIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  const questions: QuestionJSON[] = [];

  // Fetch all question JSONs
  for (let i = 0; i < questionIds.length; i++) {
    const id = questionIds[i];
    const basePath = `${BASE_URL}/${id}`;
    try {
      const response = await fetch(`${basePath}/${id}.json`);
      if (!response.ok) {
        console.warn(`Failed to fetch question ${id}: ${response.status}`);
        continue;
      }
      const json: QuestionJSON = await response.json();
      questions.push(json);
    } catch (err) {
      console.warn(`Error fetching question ${id}:`, err);
    }
    onProgress?.(i + 1, questionIds.length);
  }

  // Generate all question divs
  const questionDivs = questions.map((q) => generateQuestionHTML(q)).join('\n');

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
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
            </head>
            <body>
<div class="instances instances--instances-preview" id="questionList">
${questionDivs}
</div>
</body></html>
`;
}
