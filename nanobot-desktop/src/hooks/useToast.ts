/**
 * Custom hook for toast notification system.
 * Provides non-intrusive feedback to the user for async operations.
 */
import { useCallback, useState } from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = "info", duration = 3000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, type, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }

    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback((msg: string, duration?: number) => addToast(msg, "success", duration), [addToast]);
  const error = useCallback((msg: string, duration?: number) => addToast(msg, "error", duration ?? 5000), [addToast]);
  const info = useCallback((msg: string, duration?: number) => addToast(msg, "info", duration), [addToast]);
  const warning = useCallback((msg: string, duration?: number) => addToast(msg, "warning", duration ?? 4000), [addToast]);

  return { toasts, addToast, removeToast, success, error, info, warning };
}
