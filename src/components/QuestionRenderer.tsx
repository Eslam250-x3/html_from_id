import { useRef, useEffect, useState } from 'react';

interface QuestionRendererProps {
    questionId: string;
    index: number;
    onStatusChange: (id: string, status: 'loading' | 'loaded' | 'error') => void;
}

const ENGINE_URL = 'https://beta-classes-resources.nagwa.com/engines/unzipped/nagwa_questions_engine/index.html';
const BASE_URL = 'https://s3.us-east-1.amazonaws.com/beta-qms.nagwa.com/questions';

export default function QuestionRenderer({ questionId, index, onStatusChange }: QuestionRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [height, setHeight] = useState(250);
    const [error, setError] = useState<string | null>(null);
    const initRef = useRef(false);

    useEffect(() => {
        if (initRef.current) return;
        initRef.current = true;

        const container = containerRef.current;
        if (!container) return;

        onStatusChange(questionId, 'loading');

        const basePath = `${BASE_URL}/${questionId}`;
        const jsonPromise = fetch(`${basePath}/${questionId}.json`);

        const iframe = document.createElement('iframe');
        iframeRef.current = iframe;
        iframe.style.width = '100%';
        iframe.style.border = 'none';
        iframe.style.minHeight = '200px';
        iframe.style.height = `${height}px`;

        iframe.onload = async () => {
            try {
                const resp = await jsonPromise;
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const questionJson = await resp.json();

                iframe.contentWindow?.postMessage(
                    JSON.stringify({
                        action: 'init',
                        payload: {
                            question: questionJson,
                            assetsBasePath: basePath,
                            mode: 'session_tutor',
                        },
                    }),
                    '*'
                );
                onStatusChange(questionId, 'loaded');
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
                onStatusChange(questionId, 'error');
            }
        };

        iframe.src = ENGINE_URL;
        container.appendChild(iframe);

        return () => {
            // cleanup handled by React unmount
        };
    }, [questionId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                if (['questionRendered', 'questionHeightChanged'].includes(data.messageKey)) {
                    if (data.questionId === questionId && data.questionHeight) {
                        const newH = Number(data.questionHeight);
                        setHeight(newH);
                        if (iframeRef.current) {
                            iframeRef.current.style.height = `${newH}px`;
                        }
                    }
                }
            } catch {
                // ignore non-JSON messages
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [questionId]);

    const statusClass = error ? 'status-error' : 'status-loading';
    const statusText = error ? `Error: ${error}` : 'Loading...';

    return (
        <div className="question-card">
            <div className="question-card-header">
                <span className="question-id">
                    #{index + 1} — {questionId}
                </span>
                <span className={`question-status ${statusClass}`}>
                    <span className="status-dot"></span>
                    {statusText}
                </span>
            </div>
            <div
                className="question-iframe-container"
                ref={containerRef}
                style={{ height: `${height}px` }}
            />
        </div>
    );
}
