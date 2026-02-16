import Papa from 'papaparse';

export function parseCSV(file: File): Promise<string[]> {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const ids: string[] = [];
                for (const row of results.data as Record<string, string>[]) {
                    const id = row['question_id'] || row['Question_ID'] || row['questionId'] || row['id'];
                    if (id && id.trim()) {
                        ids.push(id.trim());
                    }
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
