import { useSyncExternalStore } from 'react'

export type ToastVariant = 'default' | 'destructive'

export type ToastOptions = {
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

export type ToasterToast = {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  duration?: number
  open: boolean
}

type ToastState = {
  toasts: ToasterToast[]
}

export const TOAST_LIMIT = 5

let count = 0
function nextToastId(): string {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return `toast-${count}`
}

const listeners = new Set<() => void>()
let memoryState: ToastState = { toasts: [] }
const serverState: ToastState = { toasts: [] }

function emitChange() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ToastState {
  return memoryState
}

function getServerSnapshot(): ToastState {
  return serverState
}

export const dismissToast = (toastId?: string) => {
  if (toastId) {
    memoryState = {
      toasts: memoryState.toasts.filter((t) => t.id !== toastId),
    }
  } else {
    memoryState = { toasts: [] }
  }
  emitChange()
}

export const toast = ({
  title,
  description,
  variant = 'default',
  duration,
}: ToastOptions) => {
  const id = nextToastId()
  const item: ToasterToast = {
    id,
    title,
    description,
    variant,
    duration,
    open: true,
  }

  memoryState = {
    toasts: [...memoryState.toasts.filter((t) => t.open), item].slice(-TOAST_LIMIT),
  }
  emitChange()

  return {
    id,
    dismiss: () => dismissToast(id),
  }
}

export const useToast = () => {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return {
    ...state,
    toast,
    dismiss: dismissToast,
  }
}
