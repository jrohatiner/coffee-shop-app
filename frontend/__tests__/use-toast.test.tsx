import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Input from '../components/ui/Input'
import { Toaster, ToasterView } from '../components/ui/toaster'
import {
  clearToasts,
  DEDUPE_WINDOW_MS,
  DEFAULT_TOAST_DURATION_MS,
  DESTRUCTIVE_TOAST_DURATION_MS,
  dismissToast,
  getServerToastsSnapshot,
  getToastsSnapshot,
  pauseToast,
  resumeToast,
  subscribeToasts,
  toast,
} from '../components/ui/use-toast'

describe('use-toast reactive store', () => {
  beforeEach(() => {
    mock.timers.reset()
    clearToasts()
  })

  it('publishes updates to subscribers and preserves toast({ title, description, variant }) defaults', () => {
    let notifications = 0
    const unsubscribe = subscribeToasts(() => {
      notifications += 1
    })

    assert.deepEqual(getServerToastsSnapshot(), [])
    assert.deepEqual(getToastsSnapshot(), [])

    toast({ title: 'Order created' })
    const firstSnapshot = getToastsSnapshot()
    assert.equal(firstSnapshot.length, 1)
    assert.equal(firstSnapshot[0].title, 'Order created')
    assert.equal(firstSnapshot[0].variant, 'default')
    assert.equal(firstSnapshot[0].remainingMs, DEFAULT_TOAST_DURATION_MS)
    assert.equal(notifications, 1)

    toast({
      title: 'Login failed',
      description: 'Invalid credentials',
      variant: 'destructive',
    })
    const secondSnapshot = getToastsSnapshot()
    assert.equal(secondSnapshot.length, 2)
    assert.equal(secondSnapshot[1].variant, 'destructive')
    assert.equal(secondSnapshot[1].description, 'Invalid credentials')
    assert.equal(secondSnapshot[1].remainingMs, DESTRUCTIVE_TOAST_DURATION_MS)
    assert.equal(notifications, 2)

    unsubscribe()
  })

  it('auto-dismisses default toasts after standard duration and destructive toasts after extended duration', () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    toast({ title: 'Saved', description: 'Latte' })
    toast({
      title: 'Error',
      description: 'Manager only',
      variant: 'destructive',
    })
    assert.equal(getToastsSnapshot().length, 2)

    mock.timers.tick(DEFAULT_TOAST_DURATION_MS - 1)
    assert.equal(getToastsSnapshot().length, 2)

    mock.timers.tick(1)
    const remaining = getToastsSnapshot()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].variant, 'destructive')

    mock.timers.tick(
      DESTRUCTIVE_TOAST_DURATION_MS - DEFAULT_TOAST_DURATION_MS - 1
    )
    assert.equal(getToastsSnapshot().length, 1)

    mock.timers.tick(1)
    assert.equal(getToastsSnapshot().length, 0)
  })

  it('pauses dismissal timers on hover and focus and resumes only after all pause reasons clear', () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    const created = toast({ title: 'Order created' })
    mock.timers.tick(2000)

    pauseToast(created.id, 'hover')
    pauseToast(created.id, 'focus')

    const pausedItem = getToastsSnapshot()[0]
    assert.equal(pausedItem.paused, true)
    assert.equal(pausedItem.remainingMs, DEFAULT_TOAST_DURATION_MS - 2000)

    // Even after 20 seconds while paused, toast stays visible
    mock.timers.tick(20000)
    assert.equal(getToastsSnapshot().length, 1)

    // Leaving hover while focus remains inside keeps timer paused
    resumeToast(created.id, 'hover')
    mock.timers.tick(5000)
    assert.equal(getToastsSnapshot().length, 1)
    assert.equal(getToastsSnapshot()[0].paused, true)

    // Leaving focus resumes remaining 3000ms countdown
    resumeToast(created.id, 'focus')
    assert.equal(getToastsSnapshot()[0].paused, false)
    mock.timers.tick(2999)
    assert.equal(getToastsSnapshot().length, 1)

    mock.timers.tick(1)
    assert.equal(getToastsSnapshot().length, 0)
  })

  it('supports dismissing a single toast by id or all active toasts at once', () => {
    const a = toast({ title: 'New Order' })
    toast({ title: 'Inventory Changed' })
    toast({
      title: 'Error',
      description: 'Failed to save',
      variant: 'destructive',
    })
    assert.equal(getToastsSnapshot().length, 3)

    dismissToast(a.id)
    assert.equal(getToastsSnapshot().length, 2)

    dismissToast()
    assert.equal(getToastsSnapshot().length, 0)
  })

  it('deduplicates identical default status messages within the burst window without suppressing destructive alerts', () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    toast({ title: 'Inventory Changed' })
    mock.timers.tick(500)
    toast({ title: 'Inventory Changed' })
    mock.timers.tick(500)
    toast({ title: 'Inventory Changed' })

    // Only one polite status toast should exist during the burst
    assert.equal(getToastsSnapshot().length, 1)

    // Identical destructive alerts are never suppressed so repeated failures always announce
    toast({ title: 'Name required', variant: 'destructive' })
    toast({ title: 'Name required', variant: 'destructive' })
    assert.equal(
      getToastsSnapshot().filter((item) => item.variant === 'destructive')
        .length,
      2
    )

    // Advancing past the deduplication window allows a fresh status toast
    mock.timers.tick(DEDUPE_WINDOW_MS + 10)
    toast({ title: 'Inventory Changed' })
    assert.equal(
      getToastsSnapshot().filter((item) => item.title === 'Inventory Changed')
        .length,
      2
    )
  })
})

describe('Toaster and Input accessibility primitives', () => {
  beforeEach(() => {
    mock.timers.reset()
    clearToasts()
  })

  it('pre-mounts both assertive alert and polite status live regions even when empty', () => {
    const html = renderToStaticMarkup(React.createElement(Toaster))
    assert.match(html, /role="alert"[^>]*aria-live="assertive"/)
    assert.match(html, /role="status"[^>]*aria-live="polite"/)
  })

  it('routes destructive toasts to role="alert" and default toasts to role="status" with labeled close buttons', () => {
    toast({ title: 'Order created', description: 'Table 4' })
    toast({
      title: 'Login failed',
      description: 'Invalid credentials',
      variant: 'destructive',
    })

    const html = renderToStaticMarkup(
      React.createElement(ToasterView, {
        toasts: getToastsSnapshot(),
        onDismiss: dismissToast,
        onPause: pauseToast,
        onResume: resumeToast,
      })
    )
    const alertStart = html.indexOf('role="alert"')
    const statusStart = html.indexOf('role="status"')
    assert.ok(alertStart >= 0 && statusStart > alertStart)

    const alertRegionHtml = html.slice(alertStart, statusStart)
    const statusRegionHtml = html.slice(statusStart)

    assert.match(alertRegionHtml, /Login failed/)
    assert.match(alertRegionHtml, /Invalid credentials/)
    assert.doesNotMatch(alertRegionHtml, /Order created/)
    assert.match(
      alertRegionHtml,
      /aria-label="Dismiss Login failed notification"/
    )

    assert.match(statusRegionHtml, /Order created/)
    assert.match(statusRegionHtml, /Table 4/)
    assert.doesNotMatch(statusRegionHtml, /Login failed/)
    assert.match(
      statusRegionHtml,
      /aria-label="Dismiss Order created notification"/
    )
  })

  it('wires aria-invalid, aria-describedby, and inline error text in Input', () => {
    const html = renderToStaticMarkup(
      React.createElement(Input, {
        id: 'username-field',
        label: 'Username',
        error: 'Username is required.',
      })
    )
    assert.match(html, /for="username-field"/)
    assert.match(html, /aria-invalid="true"/)
    assert.match(html, /aria-describedby="username-field-error"/)
    assert.match(
      html,
      /id="username-field-error"[^>]*>.*Username is required\./
    )
  })
})
