import { createSignal } from "solid-js";

/**
 * Transient messages. Currently only one thing produces them: a write ClickUp
 * refused. That is worth surfacing, because the mirror has already been
 * repaired by the time the user sees it and their change has visibly snapped
 * back with no explanation.
 */
export interface Toast {
  id: number;
  tone: "error" | "info";
  title: string;
  detail?: string;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export { toasts };

/**
 * Errors stay until dismissed; anything else fades.
 *
 * A failed write is the one thing the user has to read, and it arrives seconds
 * after they did something else. A notification that expires before it is seen
 * is not a notification.
 */
export function pushToast(toast: Omit<Toast, "id">, ttlMs?: number): void {
  const id = nextId++;
  setToasts((current) => [...current, { ...toast, id }]);
  const ttl = ttlMs ?? (toast.tone === "error" ? null : 6000);
  if (ttl !== null) setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
  setToasts((current) => current.filter((toast) => toast.id !== id));
}
