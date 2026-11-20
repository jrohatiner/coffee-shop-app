import { useSyncExternalStore } from 'react'

export type ToastVariant = 'default' | 'destructive'

export interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

export type ToastOptions = ToastInput

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  createdAt: number
  remainingMs: number
  paused: boolean
}

export type PauseReason = 'hover' | 'focus' | 'manual'

export const DEFAULT_TOAST_DURATION_MS = 5000
export const DESTRUCTIVE_TOAST_DURATION_MS = 10000
export const DEDUPE_WINDOW_MS = 2000
const MAX_TOASTS = 8

interface TimerRecord {
  timeoutId: ReturnType<typeof setTimeout> | null
  startedAt: number
  remainingMs: number
  pauseReasons: Set<PauseReason>
  dedupeKey: string
}

const SERVER_SNAPSHOT: ToastItem[] = []

let toastsState: ToastItem[] = []
let idCounter = 0
const listeners = new Set<() => void>()
const timers = new Map<string, TimerRecord>()
const lastDefaultEmitByKey = new Map<string, { timestamp: number; id: string }>()

const emitChange = () => {
  listeners.forEach((listener) => listener())
}

const makeDedupeKey = (variant: ToastVariant, title: string, description?: string) =>
  `${variant}::${title.trim()}::${(description ?? '').trim()}`

const scheduleTimer = (id: string, record: TimerRecord) => {
  if (record.timeoutId !== null) {
    clearTimeout(record.timeoutId)
    record.timeoutId = null
  }
  if (record.pauseReasons.size > 0 || !Number.isFinite(record.remainingMs)) {
    return
  }
  if (record.remainingMs <= 0) {
    dismissToast(id)
    return
  }
  record.startedAt = Date.now()
  record.timeoutId = setTimeout(() => {
    dismissToast(id)
  }, record.remainingMs)
}

export const subscribeToasts = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getToastsSnapshot = (): ToastItem[] => toastsState

export const getServerToastsSnapshot = (): ToastItem[] => SERVER_SNAPSHOT

export const dismissToast = (id?: string) => {
  if (!id) {
    if (toastsState.length === 0) return
    timers.forEach((record) => {
      if (record.timeoutId !== null) clearTimeout(record.timeoutId)
      lastDefaultEmitByKey.delete(record.dedupeKey)
    })
    timers.clear()
    toastsState = []
    emitChange()
    return
  }

  const record = timers.get(id)
  if (record) {
    if (record.timeoutId !== null) clearTimeout(record.timeoutId)
    lastDefaultEmitByKey.delete(record.dedupeKey)
    timers.delete(id)
  }

  const next = toastsState.filter((item) => item.id !== id)
  if (next.length !== toastsState.length) {
    toastsState = next
    emitChange()
  }
}

export const pauseToast = (id: string, reason: PauseReason = 'manual') => {
  const record = timers.get(id)
  if (!record) return

  const wasRunning = record.pauseReasons.size === 0
  record.pauseReasons.add(reason)

  if (wasRunning) {
    if (record.timeoutId !== null) {
      clearTimeout(record.timeoutId)
      record.timeoutId = null
    }
    const elapsed = Math.max(0, Date.now() - record.startedAt)
    record.remainingMs = Math.max(0, record.remainingMs - elapsed)
    toastsState = toastsState.map((item) =>
      item.id === id ? { ...item, paused: true, remainingMs: record.remainingMs } : item
    )
    emitChange()
  }
}

export const resumeToast = (id: string, reason?: PauseReason) => {
  const record = timers.get(id)
  if (!record || record.pauseReasons.size === 0) return

  if (reason) {
    record.pauseReasons.delete(reason)
  } else {
    record.pauseReasons.clear()
  }

  if (record.pauseReasons.size === 0) {
    if (record.remainingMs <= 0) {
      dismissToast(id)
      return
    }
    toastsState = toastsState.map((item) =>
      item.id === id ? { ...item, paused: false, remainingMs: record.remainingMs } : item
    )
    scheduleTimer(id, record)
    emitChange()
  }
}

export const clearToasts = () => {
  timers.forEach((record) => {
    if (record.timeoutId !== null) clearTimeout(record.timeoutId)
  })
  timers.clear()
  lastDefaultEmitByKey.clear()
  if (toastsState.length > 0) {
    toastsState = []
    emitChange()
  }
}

export const toast = ({ title, description, variant = 'default', duration }: ToastInput) => {
  const now = Date.now()
  const resolvedDuration =
    duration ?? (variant === 'destructive' ? DESTRUCTIVE_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS)
  const dedupeKey = makeDedupeKey(variant, title, description)

  if (variant === 'default') {
    const previous = lastDefaultEmitByKey.get(dedupeKey)
    if (previous && now - previous.timestamp < DEDUPE_WINDOW_MS) {
      const existing = toastsState.find((item) => item.id === previous.id)
      const existingRecord = timers.get(previous.id)
      if (existing && existingRecord) {
        lastDefaultEmitByKey.set(dedupeKey, { timestamp: now, id: existing.id })
        existingRecord.remainingMs = resolvedDuration
        scheduleTimer(existing.id, existingRecord)
        return {
          id: existing.id,
          dismiss: () => dismissToast(existing.id),
        }
      }
    }
  }

  const id = `toast-${++idCounter}`
  const item: ToastItem = {
    id,
    title,
    description,
    variant,
    createdAt: now,
    remainingMs: resolvedDuration,
    paused: false,
  }

  const record: TimerRecord = {
    timeoutId: null,
    startedAt: now,
    remainingMs: resolvedDuration,
    pauseReasons: new Set<PauseReason>(),
    dedupeKey,
  }
  timers.set(id, record)

  if (variant === 'default') {
    lastDefaultEmitByKey.set(dedupeKey, { timestamp: now, id })
  }

  let next = [...toastsState, item]
  if (next.length > MAX_TOASTS) {
    const overflow = next.slice(0, next.length - MAX_TOASTS)
    overflow.forEach((evicted) => {
      const evictedRecord = timers.get(evicted.id)
      if (evictedRecord?.timeoutId) clearTimeout(evictedRecord.timeoutId)
      timers.delete(evicted.id)
    })
    next = next.slice(next.length - MAX_TOASTS)
  }

  toastsState = next
  scheduleTimer(id, record)
  emitChange()

  return {
    id,
    dismiss: () => dismissToast(id),
  }
}

export const useToast = () => {
  const toasts = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getServerToastsSnapshot)
  return {
    toasts,
    toast,
    dismiss: dismissToast,
    pauseToast,
    resumeToast,
  }
}
