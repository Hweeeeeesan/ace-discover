'use client';

import { ExternalLink, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ADMIN_PREVIEW_DEVICES,
  DEFAULT_ADMIN_PREVIEW_DEVICE,
  DEFAULT_ADMIN_PREVIEW_PATH,
  safePublicPreviewPath,
} from '../lib/admin/app-preview';

export default function AdminAppPreview() {
  const iframeRef = useRef(null);
  const stageRef = useRef(null);
  const [device, setDevice] = useState(DEFAULT_ADMIN_PREVIEW_DEVICE);
  const [scale, setScale] = useState(1);
  const [currentPath, setCurrentPath] = useState(DEFAULT_ADMIN_PREVIEW_PATH);
  const viewport = ADMIN_PREVIEW_DEVICES[device];

  const resizePreview = useCallback(() => {
    const availableWidth = Math.max(0, (stageRef.current?.clientWidth || viewport.width) - 36);
    setScale(Math.min(1, availableWidth / viewport.width));
  }, [viewport.width]);

  const rememberCurrentRoute = useCallback(() => {
    try {
      setCurrentPath(safePublicPreviewPath(
        iframeRef.current?.contentWindow?.location.href,
        window.location.origin,
      ));
    } catch {
      setCurrentPath(DEFAULT_ADMIN_PREVIEW_PATH);
    }
  }, []);

  useEffect(() => {
    resizePreview();
    const observer = new ResizeObserver(resizePreview);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [resizePreview]);

  useEffect(() => {
    const timer = window.setInterval(rememberCurrentRoute, 400);
    return () => window.clearInterval(timer);
  }, [rememberCurrentRoute]);

  function refreshPreview() {
    iframeRef.current?.contentWindow?.location.reload();
  }

  return (
    <section className="admin-app-preview" aria-labelledby="admin-app-preview-title">
      <header className="admin-app-preview-toolbar">
        <div className="admin-app-preview-heading">
          <span>Preview</span>
          <strong id="admin-app-preview-title">Interactive public app</strong>
          <small title={currentPath}>{currentPath}</small>
        </div>
        <div className="admin-preview-device-toggle" role="group" aria-label="Preview viewport">
          <button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>
            <Monitor size={14} aria-hidden="true" /> Desktop
          </button>
          <button type="button" aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}>
            <Smartphone size={14} aria-hidden="true" /> Mobile
          </button>
        </div>
        <div className="admin-app-preview-actions">
          <span aria-live="polite">{viewport.label}</span>
          <button type="button" onClick={refreshPreview} aria-label="Refresh app preview">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
          <a href={currentPath} target="_blank" rel="noopener noreferrer">
            Open <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      </header>
      <div className={`admin-app-preview-stage is-${device}`} ref={stageRef}>
        <div
          className="admin-app-preview-size"
          style={{ width: viewport.width * scale, height: viewport.height * scale }}
        >
          <iframe
            ref={iframeRef}
            className="admin-app-preview-frame"
            src={DEFAULT_ADMIN_PREVIEW_PATH}
            title={`ACE Discover ${device} preview`}
            width={viewport.width}
            height={viewport.height}
            onLoad={rememberCurrentRoute}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            referrerPolicy="same-origin"
            style={{ transform: `scale(${scale})` }}
          />
        </div>
      </div>
      <p className="admin-app-preview-note">Click inside to interact. Scrolling and navigation stay within this preview.</p>
    </section>
  );
}
