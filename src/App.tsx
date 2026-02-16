import { useState, useRef, useCallback } from 'react';
import { parseCSV } from './utils/csvParser';
import { generateExportHTML } from './utils/htmlExporter';
import QuestionRenderer from './components/QuestionRenderer';

type QuestionStatus = 'loading' | 'loaded' | 'error';

export default function App() {
    const [questionIds, setQuestionIds] = useState<string[]>([]);
    const [statuses, setStatuses] = useState<Record<string, QuestionStatus>>({});
    const [dragOver, setDragOver] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState({ loaded: 0, total: 0 });
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const showToast = (message: string, type: 'success' | 'error') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    };

    const handleFile = async (file: File) => {
        try {
            const ids = await parseCSV(file);
            setQuestionIds(ids);
            setStatuses({});
            showToast(`✅ Loaded ${ids.length} question IDs`, 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to parse CSV', 'error');
        }
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(true);
    };

    const onDragLeave = () => setDragOver(false);

    const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
    };

    const handleStatusChange = useCallback((id: string, status: QuestionStatus) => {
        setStatuses((prev) => ({ ...prev, [id]: status }));
    }, []);

    const handleExport = async () => {
        setExporting(true);
        setExportProgress({ loaded: 0, total: questionIds.length });
        try {
            const html = await generateExportHTML(questionIds, (loaded, total) => {
                setExportProgress({ loaded, total });
            });
            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Questions_Export.html';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('📄 HTML file exported successfully!', 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Export failed', 'error');
        } finally {
            setExporting(false);
        }
    };

    const handleReset = () => {
        setQuestionIds([]);
        setStatuses({});
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const loadedCount = Object.values(statuses).filter((s) => s === 'loaded').length;
    const errorCount = Object.values(statuses).filter((s) => s === 'error').length;
    const loadingCount = questionIds.length - loadedCount - errorCount;
    const progress = questionIds.length > 0 ? Math.round(((loadedCount + errorCount) / questionIds.length) * 100) : 0;

    return (
        <div className="app-container">
            <header className="app-header">
                <h1>📝 Question Renderer</h1>
                <p>Upload a CSV file with question IDs to render and export questions</p>
            </header>

            {questionIds.length === 0 ? (
                <div
                    className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <div className="upload-zone-content">
                        <span className="upload-icon">📁</span>
                        <h3>Drop CSV file here or click to browse</h3>
                        <p>Accepts .csv files with a "question_id" column</p>
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv"
                        onChange={onFileInput}
                    />
                </div>
            ) : (
                <>
                    {/* Stats */}
                    <div className="stats-bar">
                        <div className="stat-card">
                            <div className="stat-value">{questionIds.length}</div>
                            <div className="stat-label">Total Questions</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{loadedCount}</div>
                            <div className="stat-label">Loaded</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{loadingCount}</div>
                            <div className="stat-label">Loading</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-value">{errorCount}</div>
                            <div className="stat-label">Errors</div>
                        </div>
                    </div>

                    {/* Progress */}
                    {progress < 100 && (
                        <div className="progress-container">
                            <div className="progress-header">
                                <span className="progress-text">Rendering questions...</span>
                                <span className="progress-percent">{progress}%</span>
                            </div>
                            <div className="progress-bar-track">
                                <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                            </div>
                        </div>
                    )}

                    {/* Controls */}
                    <div className="controls-bar">
                        <button className="btn btn-success" onClick={handleExport} disabled={exporting}>
                            <span className="btn-icon">{exporting ? '⏳' : '📄'}</span>
                            {exporting
                                ? `Fetching ${exportProgress.loaded}/${exportProgress.total}...`
                                : 'Export as HTML'}
                        </button>
                        <button className="btn btn-secondary" onClick={handleReset}>
                            <span className="btn-icon">🔄</span>
                            Reset
                        </button>
                    </div>

                    {/* Questions */}
                    <div className="questions-section">
                        <h2>Questions ({questionIds.length})</h2>
                        <div className="questions-grid">
                            {questionIds.map((id, i) => (
                                <QuestionRenderer
                                    key={id}
                                    questionId={id}
                                    index={i}
                                    onStatusChange={handleStatusChange}
                                />
                            ))}
                        </div>
                    </div>
                </>
            )}

            {/* Toast */}
            {toast && (
                <div className={`toast ${toast.type}`}>
                    {toast.message}
                </div>
            )}
        </div>
    );
}
