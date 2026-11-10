"use client";
// App-wide feedback: toasts for transaction results and a confirm dialog for
// actions that can't be taken back. Mounted once in the root layout.
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./interactive";
import { Button, cx } from "./ui";

// ------------------------------------------------------------------ toasts

export type ToastTone = "ok" | "error" | "pending" | "info";
export interface ToastInput {
  tone?: ToastTone;
  title: ReactNode;
  body?: ReactNode;
  href?: string;
  hrefLabel?: string;
  /** ms; Infinity keeps it until dismissed or updated. Errors default to 9s. */
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}
interface ToastApi {
  show(t: ToastInput): number;
  update(id: number, t: ToastInput): void;
  dismiss(id: number): void;
}

const ToastCtx = createContext<ToastApi | null>(null);
export function useToast(): ToastApi {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast outside Providers");
  return c;
}

function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((l) => l.filter((t) => t.id !== id));
  }, []);
  const arm = useCallback(
    (id: number, t: ToastInput) => {
      clearTimeout(timers.current.get(id));
      const ms = t.duration ?? (t.tone === "pending" ? Infinity : t.tone === "error" ? 9000 : 5000);
      if (Number.isFinite(ms)) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show(t) {
        const id = ++seq.current;
        setItems((l) => [...l.slice(-3), { ...t, id }]);
        arm(id, t);
        return id;
      },
      update(id, t) {
        setItems((l) => (l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? { ...t, id } : x)) : [...l.slice(-3), { ...t, id }]));
        arm(id, t);
      },
      dismiss,
    }),
    [arm, dismiss],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[80] flex flex-col items-center gap-2 px-3 lg:bottom-6 lg:items-end lg:px-6"
      >
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96, transition: { duration: 0.16 } }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              role={t.tone === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-[440px] items-start gap-3 rounded-[20px] bg-toast py-3 pl-3.5 pr-2 text-toast-fg shadow-float"
            >
              <span
                aria-hidden
                className={cx(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                  t.tone === "error" ? "bg-[#E11D48] text-white" : t.tone === "pending" ? "bg-[var(--toast-sub)]" : "bg-primary text-white",
                )}
              >
                {t.tone === "error" ? <CircleAlert className="size-3.5" /> : t.tone === "pending" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                <span className="text-[15px] font-semibold leading-snug">{t.title}</span>
                {t.body && <span className="break-words text-[13px] leading-snug opacity-75">{t.body}</span>}
                {t.href && (
                  <a href={t.href} target="_blank" rel="noreferrer" className="self-start text-[13px] font-semibold underline underline-offset-4">
                    {t.hrefLabel ?? "View transaction"}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="flex size-9 shrink-0 items-center justify-center rounded-full opacity-70 hover:bg-white/10 hover:opacity-100">
                <X aria-hidden className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

// ----------------------------------------------------------------- confirm

export interface ConfirmInput {
  title: ReactNode;
  body?: ReactNode;
  /** Key/value rows shown in a summary box ("To", "Network fee"…). */
  rows?: [ReactNode, ReactNode][];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger" | "ink";
  /** A statement the person must tick before confirming. */
  acknowledge?: string;
}
type ConfirmFn = (c: ConfirmInput) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);
export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error("useConfirm outside Providers");
  return c;
}

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmInput & { resolve: (b: boolean) => void }) | null>(null);
  const [ack, setAck] = useState(false);
  const confirm = useCallback<ConfirmFn>(
    (c) =>
      new Promise<boolean>((resolve) => {
        setAck(false);
        setReq({ ...c, resolve });
      }),
    [],
  );
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!req}
        onClose={() => close(false)}
        title={req?.title ?? ""}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)} autoFocus={req?.tone === "danger"}>
              {req?.cancelLabel ?? "Not now"}
            </Button>
            <Button variant={req?.tone ?? "primary"} disabled={!!req?.acknowledge && !ack} onClick={() => close(true)} autoFocus={req?.tone !== "danger"}>
              {req?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {req?.body && <div className="text-[15px] leading-relaxed text-muted">{req.body}</div>}
        {req?.rows && req.rows.length > 0 && (
          <dl className="rounded-row bg-subtle px-4 py-1.5">
            {req.rows.map(([k, v], i) => (
              <div key={i} className={cx("flex items-baseline justify-between gap-4 py-2.5 text-sm", i > 0 && "border-t border-line")}>
                <dt className="shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 break-words text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {req?.acknowledge && (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-tile border border-line p-3 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
            <span>{req.acknowledge}</span>
          </label>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
