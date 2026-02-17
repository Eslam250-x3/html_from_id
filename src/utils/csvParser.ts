import Papa from 'papaparse';

const QUESTION_ID_KEYS = new Set(['question_id', 'questionid', 'id']);

function normalizeHeaderKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s-]+/g, '').replace(/[^a-z0-9_]/g, '');
}

function extractQuestionId(row: Record<string, unknown>): string | null {
    for (const [key, rawValue] of Object.entries(row)) {
        if (!QUESTION_ID_KEYS.has(normalizeHeaderKey(key))) {
            continue;
        }

        const value = String(rawValue ?? '').trim();
        if (value) {
            return value;
        }
    }

    return null;
}

export function parseCSV(file: File): Promise<string[]> {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const ids: string[] = [];
                const seen = new Set<string>();

                for (const row of results.data as Record<string, unknown>[]) {
                    const id = extractQuestionId(row);
                    if (!id || seen.has(id)) {
                        continue;
                    }

                    seen.add(id);
                    ids.push(id);
                }

                if (ids.length === 0) {
                    reject(new Error('No question IDs found in CSV. Make sure the CSV has a column named "question_id".'));
                } else {
                    resolve(ids);
                }
            },
            error: (error: Error) => {
                reject(error);
            },
        });
    });
}
