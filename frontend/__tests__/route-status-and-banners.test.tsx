import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer'
import api from '../lib/api'
import { clearToasts } from '../components/ui/use-toast'
import { render, fireClick } from './test-dom'

const routerModule = require('next/router')
const socketIoModule = require('socket.io-client')

const fakeRouter = {
  pathname: '/dashboard',
  push: () => Promise.resolve(true),
}

import Dashboard from '../pages/dashboard'
import Reports from '../pages/reports'
import Orders from '../pages/orders'
import Inventory from '../pages/inventory'

function makeValidJwt(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'manager@coffee.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, val: string) => {
      store.set(key, String(val))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

function getText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : getText(child)))
    .join('')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Route status live regions and FormErrorBanner alerts', () => {
  const originalApiGet = api.get
  let originalUseRouter: any
  let originalSocketIo: any

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    originalUseRouter = routerModule.useRouter
    originalSocketIo = socketIoModule.io
    routerModule.useRouter = () => fakeRouter
    socketIoModule.io = () => ({
      on: () => {},
      disconnect: () => {},
    })
    clearToasts()
    const storage = createMemoryStorage()
    storage.setItem('token', makeValidJwt())
    ;(globalThis as any).localStorage = storage
  })

  afterEach(() => {
    api.get = originalApiGet
    routerModule.useRouter = originalUseRouter
    socketIoModule.io = originalSocketIo
    clearToasts()
  })

  it('Dashboard announces loading with role="status" and renders FormErrorBanner instead of $0.00 on error', async () => {
    const req = deferred<{ data: any }>()
    api.get = ((url: string) => {
      assert.equal(url, '/dashboard/summary')
      return req.promise as any
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Dashboard />)
        await flushPromises()
      })

      const statusNodes = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'status'
      )
      assert.equal(statusNodes.length, 1)
      assert.equal(statusNodes[0].props['aria-live'], 'polite')
      assert.match(getText(statusNodes[0]), /Loading dashboard summary/i)
      assert.doesNotMatch(getText(renderer.root), /\$0(\.00)?/)

      await act(async () => {
        req.reject({ response: { data: { detail: 'Database unavailable' } } })
        await flushPromises()
      })

      const alertNodes = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'alert'
      )
      assert.equal(alertNodes.length, 1)
      assert.equal(getText(alertNodes[0]), 'Database unavailable')
      assert.doesNotMatch(getText(renderer.root), /\$0(\.00)?/)
    } finally {
      renderer?.unmount()
    }
  })

  it('Reports clears prior rows immediately on tab switch, announces loading/empty status, and renders FormErrorBanner on error without stealing focus', async () => {
    const dailyReq = deferred<{ data: any[] }>()
    const weeklyReq = deferred<{ data: any[] }>()
    const monthlyReq = deferred<{ data: any[] }>()

    api.get = ((url: string) => {
      if (url === '/reports/daily') return dailyReq.promise as any
      if (url === '/reports/weekly') return weeklyReq.promise as any
      if (url === '/reports/monthly') return monthlyReq.promise as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any

    const view = render(<Reports />)
    try {
      // Loading daily initially
      await act(async () => {
        await flushPromises()
      })
      const initialStatus = view.container.querySelector('[role="status"]')
      assert.ok(initialStatus, 'renders role="status" while daily reports load')
      assert.match(initialStatus.textContent, /Loading daily sales reports/i)

      // Resolve daily with rows
      await act(async () => {
        dailyReq.resolve({
          data: [{ id: 1, report_type: 'daily', total_sales: 125.5 }],
        })
        await flushPromises()
      })
      assert.match(view.container.textContent, /DAILY/)
      assert.match(view.container.textContent, /\$125\.50/)

      // Switch to Weekly tab: prior daily rows clear immediately while weekly is in flight
      const [, weeklyTab, monthlyTab] =
        view.container.querySelectorAll('[role="tab"]')
      fireClick(weeklyTab)
      assert.equal(view.document.activeElement, weeklyTab)
      assert.doesNotMatch(view.container.textContent, /\$125\.50/)
      const weeklyLoading = view.container.querySelector('[role="status"]')
      assert.ok(weeklyLoading, 'announces loading on weekly tab')
      assert.match(weeklyLoading.textContent, /Loading weekly sales reports/i)

      // Reject weekly: renders FormErrorBanner (role="alert") and preserves focus on weeklyTab
      await act(async () => {
        weeklyReq.reject({
          response: { data: { detail: 'Report service offline' } },
        })
        await flushPromises()
      })
      const alertBanner = view.container.querySelector('[role="alert"]')
      assert.ok(alertBanner, 'renders FormErrorBanner on weekly failure')
      assert.equal(alertBanner.textContent, 'Report service offline')
      assert.equal(view.document.activeElement, weeklyTab)
      assert.doesNotMatch(view.container.textContent, /\$125\.50/)

      // Switch to Monthly tab: resolves empty and announces empty state via role="status"
      fireClick(monthlyTab)
      assert.equal(view.container.querySelector('[role="alert"]'), null)
      await act(async () => {
        monthlyReq.resolve({ data: [] })
        await flushPromises()
      })
      const emptyStatus = view.container.querySelector('[role="status"]')
      assert.ok(
        emptyStatus,
        'announces empty monthly reports via role="status"'
      )
      assert.match(
        emptyStatus.textContent,
        /No monthly sales reports available/i
      )
      assert.equal(view.document.activeElement, monthlyTab)
    } finally {
      view.unmount()
    }
  })

  it('Orders exposes role="status" on empty results and pagination counts, and renders FormErrorBanner when /inventory fails', async () => {
    const ordersReq = deferred<{
      data: any[]
      headers?: Record<string, string>
    }>()
    const inventoryReq = deferred<{ data: any[] }>()

    api.get = ((url: string) => {
      if (url === '/orders') return ordersReq.promise as any
      if (url === '/inventory') return inventoryReq.promise as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      const loadingStatuses = renderer.root
        .findAll((n) => typeof n.type === 'string' && n.props.role === 'status')
        .map(getText)
      assert.ok(loadingStatuses.some((t) => /Loading products/i.test(t)))
      assert.ok(loadingStatuses.some((t) => /Loading orders/i.test(t)))

      await act(async () => {
        ordersReq.resolve({ data: [], headers: { 'x-has-more': 'false' } })
        inventoryReq.reject({
          response: { data: { detail: 'Inventory service unavailable' } },
        })
        await flushPromises()
      })

      const alerts = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'alert'
      )
      assert.equal(alerts.length, 1)
      assert.equal(getText(alerts[0]), 'Inventory service unavailable')

      const statuses = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'status'
      )
      const statusTexts = statuses.map(getText)
      assert.ok(statusTexts.some((t) => /No orders found\./.test(t)))
      assert.ok(statusTexts.some((t) => /Page 1 · Showing 0 orders/.test(t)))
      for (const node of statuses) {
        assert.equal(node.props['aria-live'], 'polite')
      }
    } finally {
      renderer?.unmount()
    }
  })

  it('Inventory announces loading/empty via role="status" and renders FormErrorBanner instead of stale rows on /inventory failure', async () => {
    let callCount = 0
    const secondLoad = deferred<{ data: any[] }>()

    api.get = ((url: string) => {
      assert.equal(url, '/inventory')
      callCount += 1
      if (callCount === 1) {
        return Promise.resolve({
          data: [{ id: 1, name: 'Espresso', price: 3.5, stock: 12 }],
        }) as any
      }
      return secondLoad.promise as any
    }) as any

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Inventory />)
        await flushPromises()
      })

      assert.equal(renderer.root.findAllByType('fieldset').length, 1)

      // Trigger reload failure by remounting against failing endpoint
      renderer.unmount()
      api.get = (() => secondLoad.promise as any) as any

      await act(async () => {
        renderer = TestRenderer.create(<Inventory />)
        await flushPromises()
      })

      const loadingNodes = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'status'
      )
      assert.equal(loadingNodes.length, 1)
      assert.match(getText(loadingNodes[0]), /Loading inventory/i)

      await act(async () => {
        secondLoad.reject({
          response: { data: { detail: 'Failed to fetch inventory list' } },
        })
        await flushPromises()
      })

      const alerts = renderer.root.findAll(
        (n) => typeof n.type === 'string' && n.props.role === 'alert'
      )
      assert.equal(alerts.length, 1)
      assert.equal(getText(alerts[0]), 'Failed to fetch inventory list')
      assert.equal(renderer.root.findAllByType('fieldset').length, 0)
    } finally {
      renderer?.unmount()
    }
  })
})
