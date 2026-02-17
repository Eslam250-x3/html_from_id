import { useRef, useEffect, useState } from 'react';

interface QuestionRendererProps {
    questionId: string;
    index: number;
    onStatusChange: (id: string, status: 'loading' | 'loaded' | 'error') => void;
}

const ENGINE_URL = 'https://classes-resources.nagwa.com/engines/unzipped/nagwa_questions_engine/index.html';
const ENGINE_ORIGIN = new URL(ENGINE_URL).origin;
const BASE_URL = '/api/questions';
type RendererStatus = 'loading' | 'loaded' | 'error';

function parseMessageData(data: unknown): Record<string, unknown> | null {
    const parsed = typeof data === 'string' ? (() => {
        try {
            return JSON.parse(data);
        } catch {
            return null;
        }
    })() : data;

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    return parsed as Record<string, unknown>;
}

export default function QuestionRenderer({ questionId, index, onStatusChange }: QuestionRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [height, setHeight] = useState(250);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<RendererStatus>('loading');

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const controller = new AbortController();
        const basePath = `${BASE_URL}/${questionId}`;

        setError(null);
        setStatus('loading');
        onStatusChange(questionId, 'loading');

        const iframe = document.createElement('iframe');
        iframeRef.current = iframe;
        iframe.style.width = '100%';
        iframe.style.border = 'none';
        iframe.style.minHeight = '200px';
        iframe.style.height = `${height}px`;

        iframe.onload = async () => {
            try {
                const resp = await fetch(`${basePath}/${questionId}.json`, { signal: controller.signal });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const questionJson = await resp.json();
                if (controller.signal.aborted) return;

                iframe.contentWindow?.postMessage(
                    JSON.stringify({
                        action: 'init',
                        payload: {
                            question: questionJson,
                            assetsBasePath: basePath,
                            mode: 'session_tutor',
                            locale: questionJson.language_code || 'en',
                            direction: questionJson.language_code === 'ar' ? 'rtl' : 'ltr',
                        },
                    }),
                    ENGINE_ORIGIN
                );
                setStatus('loaded');
                onStatusChange(questionId, 'loaded');
            } catch (err) {
                if (controller.signal.aborted) return;
                setError(err instanceof Error ? err.message : 'Unknown error');
                setStatus('error');
                onStatusChange(questionId, 'error');
            }
        };

        iframe.src = ENGINE_URL;
        container.appendChild(iframe);

        return () => {
            controller.abort();
            iframe.onload = null;
            iframe.remove();
            iframeRef.current = null;
        };
    }, [questionId, onStatusChange]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const iframeWindow = iframeRef.current?.contentWindow;
            if (!iframeWindow) return;
            if (event.source !== iframeWindow) return;
            if (event.origin !== ENGINE_ORIGIN) return;

            const data = parseMessageData(event.data);
            if (!data) return;

            const messageKey = typeof data.messageKey === 'string' ? data.messageKey : '';
            if (!['questionRendered', 'questionHeightChanged'].includes(messageKey)) return;

            const messageQuestionId = String(data.questionId ?? '');
            if (messageQuestionId && messageQuestionId !== questionId) return;

            const newH = Number(data.questionHeight);
            if (Number.isFinite(newH) && newH > 0) {
                setHeight(newH);
                if (iframeRef.current) {
                    iframeRef.current.style.height = `${newH}px`;
                }
            }

            if (messageKey === 'questionRendered') {
                setStatus((prev) => (prev === 'error' ? prev : 'loaded'));
                onStatusChange(questionId, 'loaded');
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [questionId, onStatusChange]);

    const statusClass = status === 'error' ? 'status-error' : status === 'loaded' ? 'status-loaded' : 'status-loading';
    const statusText = status === 'error' ? `Error: ${error}` : status === 'loaded' ? 'Loaded' : 'Loading...';

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
