/**
 * Toast notification container component.
 * Renders animated toast messages in the bottom-right corner.
 */
import React from "react";
import type { Toast, ToastType } from "../hooks/useToast";

const TOAST_ICONS: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
  warning: "⚠",
};

type Props = {
  toasts: Toast[];
  onDismiss: (id: string) => void;
};

export default function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => onDismiss(t.id)}>
          <span className="toast-icon">{TOAST_ICONS[t.type]}</span>
          <span className="toast-message">{t.message}</span>
          <button className="toast-close" onClick={(e) => { e.stopPropagation(); onDismiss(t.id); }} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
