import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer'
import api from '../lib/api'
import * as dateFormatModule from '../lib/dateFormat'
import { formatOrderDate } from '../lib/dateFormat'
import OrderDetailModal from '../components/OrderDetailModal'

// Stub next/router and socket.io-client via CommonJS cache before importing pages
const routerModule = require('next/router')
const socketIoModule = require('socket.io-client')

type SocketHandler = (...args: any[]) => void

let socketListeners: Record<string, SocketHandler[]> = {}
let pushedRoutes: string[] = []

const fakeRouter = {
  pathname: '/orders',
  push: (url: string) => {
    pushedRoutes.push(url)
    return Promise.resolve(true)
  },
}

routerModule.useRouter = () => fakeRouter
socketIoModule.io = () => ({
  on: (event: string, cb: SocketHandler) => {
    socketListeners[event] = socketListeners[event] || []
    socketListeners[event].push(cb)
  },
  disconnect: () => {},
})

// Import pages after stubs are installed
import Orders from '../pages/orders'
import Dashboard from '../pages/dashboard'

function makeValidJwt(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'barista@coffee.test',
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

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('formatOrderDate', () => {
  it('formats valid ISO timestamps identically to Date.prototype.toLocaleString()', () => {
    const timestamps = [
      '2026-11-18T20:30:45Z',
      '2026-01-05T03:07:09.123Z',
      '2026-07-04T00:00:00Z',
    ]
    for (const ts of timestamps) {
      const expected = new Date(ts).toLocaleString()
      assert.equal(formatOrderDate(ts), expected)
    }
  })

  it('returns "Invalid Date" for malformed timestamps without throwing RangeError', () => {
    assert.equal(formatOrderDate('not-a-valid-date'), 'Invalid Date')
    assert.equal(formatOrderDate(''), 'Invalid Date')
    assert.equal(formatOrderDate('2026-99-99T99:99:99Z'), 'Invalid Date')
  })
})

describe('Orders page', () => {
  const originalApiGet = api.get
  const originalToLocaleString = Date.prototype.toLocaleString

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    socketListeners = {}
    pushedRoutes = []
    const storage = createMemoryStorage()
    storage.setItem('token', makeValidJwt())
    ;(globalThis as any).localStorage = storage
  })

  afterEach(() => {
    api.get = originalApiGet
    Date.prototype.toLocaleString = originalToLocaleString
  })

  it('indexes products by ID, skips missing cart products, preformats valid/invalid dates, and preserves OrderDetailModal payload', async () => {
    const sampleProducts = [
      { id: 10, name: 'Espresso', price: 3.5, stock: 25 },
      { id: 20, name: 'Oat Latte', price: 5.25, stock: 12 },
    ]
    const sampleOrders = [
      {
        id: 101,
        status: 'pending',
        created_at: '2026-11-18T18:15:00Z',
        items: [{ id: 1, quantity: 2, product: { name: 'Espresso' } }],
      },
      {
        id: 102,
        status: 'completed',
        created_at: 'malformed-timestamp',
        items: [{ id: 2, quantity: 1, product: { name: 'Oat Latte' } }],
      },
    ]

    const expectedValidDate = formatOrderDate(sampleOrders[0].created_at)

    let currentProducts = sampleProducts
    api.get = (async (url: string) => {
      if (url === '/orders') return { data: sampleOrders } as any
      if (url === '/inventory') return { data: currentProducts } as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any

    // Spy on Date.prototype.toLocaleString and formatOrderDate
    let toLocaleStringCalls = 0
    Date.prototype.toLocaleString = function (...args: any[]) {
      toLocaleStringCalls++
      return originalToLocaleString.apply(this, args as any)
    }

    const originalFormatOrderDate = dateFormatModule.formatOrderDate
    let formatOrderDateCalls = 0
    ;(dateFormatModule as any).formatOrderDate = function (createdAt: string) {
      formatOrderDateCalls++
      return originalFormatOrderDate(createdAt)
    }

    const originalArrayFind = Array.prototype.find
    let productFindCalls = 0
    Array.prototype.find = function (...args: any[]) {
      if (
        this.length > 0 &&
        this[0] &&
        typeof this[0] === 'object' &&
        'stock' in this[0]
      ) {
        productFindCalls++
      }
      return originalArrayFind.apply(this, args as any)
    }

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      // Zero calls to Date.prototype.toLocaleString
      assert.equal(toLocaleStringCalls, 0)
      // formatOrderDate ran once per order in sampleOrders (2 orders)
      assert.equal(formatOrderDateCalls, 2)

      // Check rendered table rows contain valid formatted date and 'Invalid Date'
      const rows = renderer.root.findAllByType('tr')
      // Header row + 2 order rows
      assert.equal(rows.length, 3)
      const row1Header = getText(rows[1].findByType('th'))
      const row1Cells = rows[1].findAllByType('td').map(getText)
      const row2Header = getText(rows[2].findByType('th'))
      const row2Cells = rows[2].findAllByType('td').map(getText)
      assert.equal(row1Header, '101')
      assert.equal(row1Cells[0], 'pending')
      assert.equal(row1Cells[1], expectedValidDate)
      assert.equal(row2Header, '102')
      assert.equal(row2Cells[0], 'completed')
      assert.equal(row2Cells[1], 'Invalid Date')

      // Interactive state updates: add both products to cart, change status, open/close modal
      const inputs = renderer.root.findAll(
        (n) => n.type === 'input' && n.props.type === 'number'
      )
      assert.equal(inputs.length, 2)

      await act(async () => {
        inputs[0].props.onChange({ target: { value: '3' } })
        inputs[1].props.onChange({ target: { value: '1' } })
      })

      const selects = renderer.root.findAllByType('select')
      assert.equal(selects.length, 3)
      const select = selects[0]
      await act(async () => {
        select.props.onChange({ target: { value: 'in_progress' } })
      })

      // Cart items resolved via O(1) Map lookup without products.find and without reformatting dates
      assert.equal(productFindCalls, 0)
      assert.equal(toLocaleStringCalls, 0)
      assert.equal(formatOrderDateCalls, 2)

      const cartListItems = renderer.root
        .findByType('ul')
        .findAllByType('li')
        .map(getText)
      assert.deepEqual(cartListItems, ['Espresso× 3', 'Oat Latte× 1'])

      // Edge case: missing product in cart (e.g. inventory lacks product 20 while cart still references it)
      currentProducts = [sampleProducts[0]]
      await act(async () => {
        const handlers = socketListeners['stock_update'] || []
        for (const fn of handlers) fn()
        await flushPromises()
      })

      const updatedCartItems = renderer.root
        .findByType('ul')
        .findAllByType('li')
        .map(getText)
      assert.deepEqual(updatedCartItems, ['Espresso× 3'])

      // Modal payload verification: clicking View passes the exact unmodified Order object
      const buttons = renderer.root.findAllByType('button')
      const viewFirstOrderBtn = buttons.find(
        (b) => getText(b) === 'View order #101'
      )
      assert.ok(viewFirstOrderBtn, 'Expected View button on order row')

      await act(async () => {
        viewFirstOrderBtn.props.onClick()
      })

      const modal = renderer.root.findByType(OrderDetailModal)
      assert.equal(modal.props.order, sampleOrders[0])
      assert.deepEqual(Object.keys(modal.props.order), [
        'id',
        'status',
        'created_at',
        'items',
      ])
      assert.equal(toLocaleStringCalls, 0)
      assert.equal(formatOrderDateCalls, 2)

      // Close modal
      await act(async () => {
        modal.props.onClose()
      })
      assert.equal(renderer.root.findAllByType(OrderDetailModal).length, 0)
    } finally {
      ;(dateFormatModule as any).formatOrderDate = originalFormatOrderDate
      Array.prototype.find = originalArrayFind
      renderer?.unmount()
    }
  })
})

describe('Dashboard page', () => {
  const originalApiGet = api.get
  const originalToLocaleString = Date.prototype.toLocaleString

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const storage = createMemoryStorage()
    storage.setItem('token', makeValidJwt())
    ;(globalThis as any).localStorage = storage
  })

  afterEach(() => {
    api.get = originalApiGet
    Date.prototype.toLocaleString = originalToLocaleString
  })

  it('preformats valid and invalid recentOrders dates without calling toLocaleString()', async () => {
    const recentOrders = [
      { id: 201, status: 'completed', created_at: '2026-11-18T12:00:00Z' },
      { id: 202, status: 'pending', created_at: 'bad-date' },
    ]
    const expectedDate = formatOrderDate(recentOrders[0].created_at)

    api.get = (async (url: string) => {
      assert.equal(url, '/dashboard/summary')
      return { data: { totalSales: 48.5, recentOrders } } as any
    }) as any

    let toLocaleStringCalls = 0
    Date.prototype.toLocaleString = function (...args: any[]) {
      toLocaleStringCalls++
      return originalToLocaleString.apply(this, args as any)
    }

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Dashboard />)
        await flushPromises()
      })

      assert.equal(toLocaleStringCalls, 0)
      const items = renderer.root
        .findByType('ul')
        .findAllByType('li')
        .map(getText)
      assert.deepEqual(items, [
        `#201 — completed — ${expectedDate}`,
        '#202 — pending — Invalid Date',
      ])
      // Ensure original API objects were not mutated
      assert.deepEqual(Object.keys(recentOrders[0]), [
        'id',
        'status',
        'created_at',
      ])
    } finally {
      renderer?.unmount()
    }
  })

  it('renders an empty list safely when summary.recentOrders is missing from API payload', async () => {
    api.get = (async () => ({ data: { totalSales: 15 } }) as any) as any

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(<Dashboard />)
        await flushPromises()
      })

      const items = renderer.root.findByType('ul').findAllByType('li')
      assert.equal(items.length, 0)
    } finally {
      renderer?.unmount()
    }
  })
})
