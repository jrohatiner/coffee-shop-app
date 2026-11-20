import { RefObject, useCallback, useEffect, useRef, useState } from 'react'

export type FocusTargetCandidate =
  RefObject<HTMLElement | null> | HTMLElement | string | null | undefined

export type FocusHandoffTarget =
  | FocusTargetCandidate
  | readonly FocusTargetCandidate[]
  | (() => FocusTargetCandidate | readonly FocusTargetCandidate[])

export type FocusOriginInput =
  RefObject<HTMLElement | null> | HTMLElement | null | undefined

export interface FocusHandoffHandle {
  commit: () => void
  cancel: () => void
}

interface PendingFocusHandoff {
  id: number
  origin: HTMLElement
  target: FocusHandoffTarget
  committed: boolean
}

const NATIVELY_FOCUSABLE_TAGS = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
])

const NOOP_HANDLE: FocusHandoffHandle = {
  commit: () => {},
  cancel: () => {},
}

function isElementConnected(el: Element | null | undefined): boolean {
  if (!el) return false
  if (typeof el.isConnected === 'boolean') {
    return el.isConnected
  }
  const doc =
    el.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
  return Boolean(doc && typeof doc.contains === 'function' && doc.contains(el))
}

function isElementDisabled(el: Element | null | undefined): boolean {
  if (!el) return true
  if ('disabled' in el && Boolean((el as HTMLButtonElement).disabled)) {
    return true
  }
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled')) {
    return true
  }
  if (
    typeof el.getAttribute === 'function' &&
    el.getAttribute('aria-disabled') === 'true'
  ) {
    return true
  }
  return false
}

function canReceiveProgrammaticFocus(
  el: HTMLElement | null | undefined
): el is HTMLElement {
  if (!el || typeof el.focus !== 'function') return false
  if (!isElementConnected(el) || isElementDisabled(el)) return false
  if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false

  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (NATIVELY_FOCUSABLE_TAGS.has(tag)) return true
  if (tag === 'A' && Boolean(el.hasAttribute?.('href'))) return true
  if (Boolean(el.isContentEditable)) return true

  return Boolean(el.hasAttribute?.('tabindex'))
}

function resolveOriginElement(origin: FocusOriginInput): HTMLElement | null {
  if (!origin) return null
  if (typeof origin === 'object' && 'current' in origin) {
    return origin.current ?? null
  }
  return origin
}

function resolveCandidateElement(
  candidate: FocusTargetCandidate,
  doc: Document
): HTMLElement | null {
  if (!candidate) return null
  if (typeof candidate === 'string') {
    const matched = doc.querySelector(candidate)
    return matched ? (matched as HTMLElement) : null
  }
  if (typeof candidate === 'object' && 'current' in candidate) {
    return candidate.current ?? null
  }
  return candidate
}

function resolveFocusableDestination(
  target: FocusHandoffTarget,
  doc: Document
): HTMLElement | null {
  const evaluated = typeof target === 'function' ? target() : target
  const candidates: readonly FocusTargetCandidate[] = Array.isArray(evaluated)
    ? evaluated
    : [evaluated as FocusTargetCandidate]

  for (const candidate of candidates) {
    const el = resolveCandidateElement(candidate, doc)
    if (canReceiveProgrammaticFocus(el)) {
      return el
    }
  }
  return null
}

/**
 * Coordinates deterministic keyboard focus handoff after React commits a DOM update
 * that unmounts or disables the currently focused interactive control.
 *
 * Handoff runs only when `origin` held `document.activeElement` at activation time
 * and actually unmounted or became disabled without the user shifting focus elsewhere.
 */
export function useFocusHandoff() {
  const pendingRef = useRef<PendingFocusHandoff | null>(null)
  const seqRef = useRef(0)
  const [, setCommitTick] = useState(0)

  const prepareFocusHandoff = useCallback(
    (
      origin: FocusOriginInput,
      target: FocusHandoffTarget
    ): FocusHandoffHandle => {
      if (typeof document === 'undefined') {
        return NOOP_HANDLE
      }

      const originEl = resolveOriginElement(origin)
      const doc = originEl?.ownerDocument ?? document
      if (!originEl || doc.activeElement !== originEl) {
        return NOOP_HANDLE
      }

      const id = ++seqRef.current
      pendingRef.current = {
        id,
        origin: originEl,
        target,
        committed: false,
      }

      return {
        commit: () => {
          if (pendingRef.current && pendingRef.current.id === id) {
            pendingRef.current.committed = true
            setCommitTick((tick) => tick + 1)
          }
        },
        cancel: () => {
          if (pendingRef.current && pendingRef.current.id === id) {
            pendingRef.current = null
          }
        },
      }
    },
    []
  )

  const handoffFocus = useCallback(
    (origin: FocusOriginInput, target: FocusHandoffTarget): void => {
      prepareFocusHandoff(origin, target).commit()
    },
    [prepareFocusHandoff]
  )

  useEffect(() => {
    const pending = pendingRef.current
    if (!pending || !pending.committed) {
      return
    }
    pendingRef.current = null

    if (typeof document === 'undefined') {
      return
    }
    const doc = pending.origin.ownerDocument ?? document

    const originUnmountedOrDisabled =
      !isElementConnected(pending.origin) || isElementDisabled(pending.origin)
    if (!originUnmountedOrDisabled) {
      return
    }

    const active = doc.activeElement as HTMLElement | null
    const focusLostOrOnOrigin =
      !active ||
      active === doc.body ||
      active === doc.documentElement ||
      active === pending.origin ||
      !isElementConnected(active) ||
      isElementDisabled(active)

    if (!focusLostOrOnOrigin) {
      return
    }

    const destination = resolveFocusableDestination(pending.target, doc)
    if (destination) {
      destination.focus()
    }
  })

  useEffect(() => {
    return () => {
      pendingRef.current = null
    }
  }, [])

  return {
    prepareFocusHandoff,
    handoffFocus,
  }
}

export default useFocusHandoff
