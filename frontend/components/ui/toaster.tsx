import React, { useEffect } from 'react'
import Button from './Button'
import { ToastItem, useToast } from './use-toast'

const AlertIcon = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    fill="currentColor"
    className="h-5 w-5 shrink-0 text-red-800 mt-0.5"
  >
    <path
      fillRule="evenodd"
      d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
      clipRule="evenodd"
    />
  </svg>
)

const StatusIcon = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    fill="currentColor"
    className="h-5 w-5 shrink-0 text-emerald-800 mt-0.5"
  >
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
      clipRule="evenodd"
    />
  </svg>
)

interface ToastCardProps {
  item: ToastItem
  onDismiss: (id: string) => void
  onPause: (id: string, reason: 'hover' | 'focus') => void
  onResume: (id: string, reason: 'hover' | 'focus') => void
}

const ToastCard = ({ item, onDismiss, onPause, onResume }: ToastCardProps) => {
  const isDestructive = item.variant === 'destructive'

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      onResume(item.id, 'focus')
    }
  }

  return (
    <div
      data-toast-id={item.id}
      data-toast-variant={item.variant}
      onMouseEnter={() => onPause(item.id, 'hover')}
      onMouseLeave={() => onResume(item.id, 'hover')}
      onFocus={() => onPause(item.id, 'focus')}
      onBlur={handleBlur}
      className={`pointer-events-auto flex items-start justify-between gap-3 rounded-md border border-l-4 p-4 shadow-lg transition-opacity ${
        isDestructive
          ? 'border-red-700 bg-red-50 text-red-900'
          : 'border-slate-700 border-l-emerald-700 bg-white text-slate-900'
      }`}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        {isDestructive ? <AlertIcon /> : <StatusIcon />}
        <div className="min-w-0">
          <div className="font-semibold text-sm leading-5 break-words">
            {item.title}
          </div>
          {item.description && (
            <div
              className={`mt-1 text-sm leading-5 break-words ${
                isDestructive ? 'text-red-900' : 'text-slate-800'
              }`}
            >
              {item.description}
            </div>
          )}
        </div>
      </div>

      <Button
        type="button"
        aria-label={`Dismiss ${item.title} notification`}
        onClick={() => onDismiss(item.id)}
        className={`shrink-0 px-2 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          isDestructive
            ? 'border-red-700 bg-white text-red-900 hover:bg-red-100 focus-visible:outline-red-800'
            : 'border-slate-600 bg-white text-slate-900 hover:bg-slate-100 focus-visible:outline-slate-900'
        }`}
      >
        <span aria-hidden="true">✕</span>
      </Button>
    </div>
  )
}

export interface ToasterViewProps {
  toasts: ToastItem[]
  onDismiss: (id?: string) => void
  onPause: (id: string, reason: 'hover' | 'focus') => void
  onResume: (id: string, reason: 'hover' | 'focus') => void
}

export const ToasterView = ({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: ToasterViewProps) => {
  const destructiveToasts = toasts.filter(
    (item) => item.variant === 'destructive'
  )
  const defaultToasts = toasts.filter((item) => item.variant !== 'destructive')

  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
    >
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="false"
        aria-relevant="additions text"
        data-testid="toast-live-assertive"
        className="flex flex-col gap-2"
      >
        {destructiveToasts.map((item) => (
          <ToastCard
            key={item.id}
            item={item}
            onDismiss={(id) => onDismiss(id)}
            onPause={onPause}
            onResume={onResume}
          />
        ))}
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        data-testid="toast-live-polite"
        className="flex flex-col gap-2"
      >
        {defaultToasts.map((item) => (
          <ToastCard
            key={item.id}
            item={item}
            onDismiss={(id) => onDismiss(id)}
            onPause={onPause}
            onResume={onResume}
          />
        ))}
      </div>
    </section>
  )
}

export const Toaster = () => {
  const { toasts, dismiss, pauseToast, resumeToast } = useToast()

  useEffect(() => {
    if (toasts.length === 0) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toasts.length, dismiss])

  return (
    <ToasterView
      toasts={toasts}
      onDismiss={dismiss}
      onPause={pauseToast}
      onResume={resumeToast}
    />
  )
}

export default Toaster
