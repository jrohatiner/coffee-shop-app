import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React, { useRef, useState } from 'react'
import { createRequire } from 'node:module'
import api from '../lib/api'
import { clearToasts, getToastsSnapshot } from '../components/ui/use-toast'
import { useFocusHandoff } from '../hooks/useFocusHandoff'
import { fireClick, render, TestElement, TestEvent } from './test-dom'
import Orders from '../pages/orders'
import Users from '../pages/users'
import Inventory from '../pages/inventory'

const requireModule = createRequire(__filename)
const { act } = requireModule('react-dom/test-utils')
const routerModule = requireModule('next/router')
const socketIoModule = requireModule('socket.io-client')

if (!Object.getOwnPropertyDescriptor(TestElement.prototype, 'options')) {
  Object.defineProperty(TestElement.prototype, 'options', {
    get(this: TestElement) {
      return this.querySelectorAll('option')
    },
    configurable: true,
  })
}

if (!Object.getOwnPropertyDescriptor(TestElement.prototype, 'value')) {
  Object.defineProperty(TestElement.prototype, 'value', {
    get(this: TestElement): string {
      if (this.tagName === 'SELECT') {
        if ('_selectValue' in (this as any)) {
          return (this as any)._selectValue
        }
        const opts = this.querySelectorAll('option')
        const selectedOpt = opts.find((o: any) => o.selected) ?? opts[0]
        return selectedOpt ? (selectedOpt as any).value : ''
      }
      if ('_inputValue' in (this as any)) {
        return (this as any)._inputValue
      }
      return this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : '')
    },
    set(this: TestElement, nextVal: unknown) {
      const str = nextVal === undefined || nextVal === null ? '' : String(nextVal)
      if (this.tagName === 'SELECT') {
        ;(this as any)._selectValue = str
        for (const opt of this.querySelectorAll('option')) {
          ;(opt as any).selected = (opt as any).value === str
        }
        return
      }
      ;(this as any)._inputValue = str
      this.setAttribute('value', str)
    },
    configurable: true,
  })
}

function makeValidJwt(sub = 'manager@coffee.test'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
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

async function flushAsync() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

function fireChange(element: TestElement, value: string) {
  act(() => {
    ;(element as any).value = value
    element.setAttribute('value', value)
    element.dispatchEvent(new TestEvent('change', { bubbles: true, cancelable: true }))
  })
}

function clickWithoutFocusing(element: TestElement) {
  act(() => {
    element.dispatchEvent(new TestEvent('click', { bubbles: true, cancelable: true }))
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useFocusHandoff hook unit behavior', () => {
  afterEach(() => {
    clearToasts()
  })

  it('hands off focus to selector or fallback ref only when trigger held active focus and unmounts/disables', async () => {
    function Harness() {
      const [showTrigger, setShowTrigger] = useState(true)
      const [disableSecond, setDisableSecond] = useState(false)
      const triggerRef = useRef<HTMLButtonElement | null>(null)
      const secondRef = useRef<HTMLButtonElement | null>(null)
      const missingTabIndexHeadingRef = useRef<HTMLHeadingElement | null>(null)
      const validHeadingRef = useRef<HTMLHeadingElement | null>(null)
      const { handoffFocus } = useFocusHandoff()

      return (
        <div>
          <h2 ref={missingTabIndexHeadingRef}>Untabbable Heading</h2>
          <h2 id="valid-heading" ref={validHeadingRef} tabIndex={-1}>
            Valid Fallback Heading
          </h2>
          <input id="unrelated-input" />
          {showTrigger && (
            <button
              id="unmount-btn"
              ref={triggerRef}
              onClick={() => {
                handoffFocus(triggerRef, '#second-btn')
                setShowTrigger(false)
              }}
            >
              Unmount Me
            </button>
          )}
          <button
            id="second-btn"
            ref={secondRef}
            disabled={disableSecond}
            onClick={() => {
              handoffFocus(secondRef, [missingTabIndexHeadingRef, validHeadingRef])
              setDisableSecond(true)
            }}
          >
            Disable Me
          </button>
        </div>
      )
    }

    const { container, document, unmount } = render(<Harness />)
    try {
      const unrelatedInput = container.querySelector('#unrelated-input')!
      const unmountBtn = container.querySelector('#unmount-btn')!
      const secondBtn = container.querySelector('#second-btn')!
      const validHeading = container.querySelector('#valid-heading')!

      // Pointer / unfocused click while focus is on #unrelated-input must NOT steal focus
      unrelatedInput.focus()
      assert.equal(document.activeElement, unrelatedInput)
      clickWithoutFocusing(unmountBtn)
      assert.equal(container.querySelector('#unmount-btn'), null)
      assert.equal(document.activeElement, unrelatedInput)

      // Focused button becoming disabled skips heading lacking tabIndex and focuses valid tabIndex=-1 heading
      fireClick(secondBtn)
      assert.equal(secondBtn.disabled, true)
      assert.equal(document.activeElement, validHeading)
    } finally {
      unmount()
    }
  })

  it('does not steal focus if user moved focus to another connected element while async work was pending', async () => {
    const deferred = createDeferred<void>()

    function AsyncHarness() {
      const [removed, setRemoved] = useState(false)
      const btnRef = useRef<HTMLButtonElement | null>(null)
      const fallbackRef = useRef<HTMLButtonElement | null>(null)
      const { prepareFocusHandoff } = useFocusHandoff()

      const handleAsyncRemove = async () => {
        const handoff = prepareFocusHandoff(btnRef, fallbackRef)
        await deferred.promise
        setRemoved(true)
        handoff.commit()
      }

      return (
        <div>
          <input id="search-box" />
          {!removed && (
            <button id="async-remove" ref={btnRef} onClick={handleAsyncRemove}>
              Remove
            </button>
          )}
          <button id="fallback-btn" ref={fallbackRef}>
            Fallback
          </button>
        </div>
      )
    }

    const { container, document, unmount } = render(<AsyncHarness />)
    try {
      const removeBtn = container.querySelector('#async-remove')!
      const searchBox = container.querySelector('#search-box')!

      fireClick(removeBtn)
      assert.equal(document.activeElement, removeBtn)

      // User tabs into search box before async request finishes
      searchBox.focus()
      assert.equal(document.activeElement, searchBox)

      await act(async () => {
        deferred.resolve()
        await flushAsync()
      })

      assert.equal(container.querySelector('#async-remove'), null)
      assert.equal(document.activeElement, searchBox)
    } finally {
      unmount()
    }
  })
})

describe('Page-level focus handoff integration across Orders, Users, and Inventory', () => {
  const originalUseRouter = routerModule.useRouter
  const originalIo = socketIoModule.io
  const originalApiGet = api.get
  const originalApiPost = api.post
  const originalApiPut = api.put
  const originalApiDelete = api.delete
  const originalLocalStorage = (globalThis as any).localStorage

  const fakeRouter = {
    pathname: '/orders',
    push: () => Promise.resolve(true),
  }
  const fakeSocket = {
    on: () => {},
    disconnect: () => {},
  }

  beforeEach(() => {
    clearToasts()
    const storage = createMemoryStorage()
    storage.setItem('token', makeValidJwt())
    ;(globalThis as any).localStorage = storage

    routerModule.useRouter = () => fakeRouter
    socketIoModule.io = () => fakeSocket
  })

  afterEach(() => {
    clearToasts()
    routerModule.useRouter = originalUseRouter
    socketIoModule.io = originalIo
    api.get = originalApiGet
    api.post = originalApiPost
    api.put = originalApiPut
    api.delete = originalApiDelete
    ;(globalThis as any).localStorage = originalLocalStorage
  })

  it('Orders: moves focus from Cancel to sibling View button when cancelled row stays visible and preserves toast', async () => {
    const ordersData = [
      { id: 101, status: 'pending', created_at: '2026-11-18T10:00:00Z' },
      { id: 102, status: 'in_progress', created_at: '2026-11-18T10:05:00Z' },
    ]
    api.get = (async (url: string) => {
      if (url === '/orders') return { data: ordersData, headers: { 'x-has-more': 'false' } } as any
      if (url === '/inventory') return { data: [] } as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any
    api.post = (async (url: string) => {
      assert.equal(url, '/orders/101/cancel')
      return { data: { id: 101, status: 'cancelled', items: [] } } as any
    }) as any

    const { container, document, unmount } = render(<Orders />)
    try {
      await act(async () => {
        await flushAsync()
      })

      const cancel101 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Cancel order #101')!
      const view101 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'View order #101')!

      await act(async () => {
        fireClick(cancel101)
        await flushAsync()
      })

      assert.equal(
        container.querySelectorAll('button').find(b => b.textContent === 'Cancel order #101'),
        undefined
      )
      assert.equal(document.activeElement, view101)
      assert.notEqual(document.activeElement, document.body)
      assert.ok(getToastsSnapshot().some(t => t.title === 'Order cancelled'))
    } finally {
      unmount()
    }
  })

  it('Orders: moves focus to next row, previous row, or #orders-heading when statusFilter removes cancelled rows', async () => {
    let serverOrders = [
      { id: 101, status: 'pending', created_at: '2026-11-18T10:30:00Z' },
      { id: 102, status: 'pending', created_at: '2026-11-18T10:20:00Z' },
      { id: 103, status: 'pending', created_at: '2026-11-18T10:10:00Z' },
    ]

    api.get = (async (url: string, config?: any) => {
      if (url === '/orders') {
        const status = config?.params?.status
        const filtered = status ? serverOrders.filter(o => o.status === status) : serverOrders
        return { data: filtered, headers: { 'x-has-more': 'false' } } as any
      }
      if (url === '/inventory') return { data: [] } as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any

    api.post = (async (url: string) => {
      const match = url.match(/^\/orders\/(\d+)\/cancel$/)
      const id = Number(match![1])
      serverOrders = serverOrders.map(o => (o.id === id ? { ...o, status: 'cancelled' } : o))
      return { data: { id, status: 'cancelled', items: [] } } as any
    }) as any

    const { container, document, unmount } = render(<Orders />)
    try {
      await act(async () => {
        await flushAsync()
      })

      const statusFilter = container.querySelector('#orders-status-filter')!
      await act(async () => {
        fireChange(statusFilter, 'pending')
        await flushAsync()
      })

      // 1. Cancel first row (#101) -> focus moves to next row (#102)'s View button
      const cancel101 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Cancel order #101')!
      await act(async () => {
        fireClick(cancel101)
        await flushAsync()
      })
      const view102 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'View order #102')!
      assert.equal(document.activeElement, view102)

      // 2. Cancel last remaining row (#103) -> focus moves to previous row (#102)'s View button
      const cancel103 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Cancel order #103')!
      await act(async () => {
        fireClick(cancel103)
        await flushAsync()
      })
      assert.equal(document.activeElement, view102)

      // 3. Cancel final remaining row (#102) -> focus moves to #orders-heading (tabIndex=-1)
      const cancel102 = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Cancel order #102')!
      await act(async () => {
        fireClick(cancel102)
        await flushAsync()
      })
      const ordersHeading = container.querySelector('#orders-heading')!
      assert.equal(ordersHeading.getAttribute('tabindex'), '-1')
      assert.equal(document.activeElement, ordersHeading)
    } finally {
      unmount()
    }
  })

  it('Orders: moves focus from Clear Filters to #orders-status-filter and handles pagination boundaries', async () => {
    let page2HasMore = false
    let page1HasMore = true

    api.get = (async (url: string, config?: any) => {
      if (url === '/orders') {
        const offset = config?.params?.offset ?? 0
        if (offset === 0) {
          return {
            data: [{ id: 101, status: 'pending', created_at: '2026-11-18T10:00:00Z' }],
            headers: { 'x-has-more': String(page1HasMore) },
          } as any
        }
        return {
          data: [{ id: 100, status: 'pending', created_at: '2026-11-18T09:00:00Z' }],
          headers: { 'x-has-more': String(page2HasMore) },
        } as any
      }
      if (url === '/inventory') return { data: [] } as any
      throw new Error(`Unexpected GET ${url}`)
    }) as any

    const { container, document, unmount } = render(<Orders />)
    try {
      await act(async () => {
        await flushAsync()
      })

      // Activate filter, then Clear Filters -> focus moves directly to #orders-status-filter
      const statusSelect = container.querySelector('#orders-status-filter')!
      await act(async () => {
        fireChange(statusSelect, 'pending')
        await flushAsync()
      })

      const clearBtn = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Clear Filters')!
      await act(async () => {
        fireClick(clearBtn)
        await flushAsync()
      })
      assert.equal(
        container.querySelectorAll('button').find(b => b.textContent === 'Clear Filters'),
        undefined
      )
      assert.equal(document.activeElement, statusSelect)

      // Pagination: Next from Page 1 onto middle Page 2 (page2HasMore = true) keeps focus on Next
      page2HasMore = true
      const nextBtn = container.querySelectorAll('button').find(b => b.textContent === 'Next')!
      const prevBtn = container.querySelectorAll('button').find(b => b.textContent === 'Previous')!

      await act(async () => {
        fireClick(nextBtn)
        await flushAsync()
      })
      assert.equal(nextBtn.disabled, false)
      assert.equal(document.activeElement, nextBtn)

      // Next from Page 2 onto final Page 3 (page2HasMore = false) disables Next and shifts focus to Previous
      page2HasMore = false
      await act(async () => {
        fireClick(nextBtn)
        await flushAsync()
      })
      assert.equal(nextBtn.disabled, true)
      assert.equal(prevBtn.disabled, false)
      assert.equal(document.activeElement, prevBtn)

      // Previous from Page 3 -> Page 2 keeps focus on Previous (still enabled)
      page2HasMore = true
      await act(async () => {
        fireClick(prevBtn)
        await flushAsync()
      })
      assert.equal(prevBtn.disabled, false)
      assert.equal(document.activeElement, prevBtn)

      // Previous from Page 2 -> Page 1 when Page 1 has more pages -> shifts focus to Next
      page1HasMore = true
      await act(async () => {
        fireClick(prevBtn)
        await flushAsync()
      })
      assert.equal(prevBtn.disabled, true)
      assert.equal(nextBtn.disabled, false)
      assert.equal(document.activeElement, nextBtn)

      // Step to Page 2, then return to Page 1 when hasMore becomes false -> falls back to #orders-heading
      page2HasMore = false
      await act(async () => {
        fireClick(nextBtn)
        await flushAsync()
      })
      assert.equal(document.activeElement, prevBtn)

      page1HasMore = false
      await act(async () => {
        fireClick(prevBtn)
        await flushAsync()
      })
      assert.equal(prevBtn.disabled, true)
      assert.equal(nextBtn.disabled, true)
      const ordersHeading = container.querySelector('#orders-heading')!
      assert.equal(document.activeElement, ordersHeading)
    } finally {
      unmount()
    }
  })

  it('Users: awaits list reload before moving focus to next row, previous row, or #existing-users-heading', async () => {
    let usersList = [
      { id: 1, username: 'alice', is_manager: true },
      { id: 2, username: 'bob', is_manager: false },
      { id: 3, username: 'carol', is_manager: false },
    ]
    let reloadGate: ReturnType<typeof createDeferred<void>> | null = null

    api.get = (async (url: string) => {
      assert.equal(url, '/users')
      if (reloadGate) {
        await reloadGate.promise
      }
      return { data: [...usersList] } as any
    }) as any

    api.delete = (async (url: string) => {
      const id = Number(url.split('/').pop())
      usersList = usersList.filter(u => u.id !== id)
      return { data: { detail: 'User deleted' } } as any
    }) as any

    const { container, document, unmount } = render(<Users />)
    try {
      await act(async () => {
        await flushAsync()
      })

      // 1. Delete middle user (bob) with deferred reload -> focus waits until reload commits, then focuses carol's Delete
      reloadGate = createDeferred<void>()
      const bobDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete user bob')!

      act(() => {
        bobDelete.focus()
        bobDelete.dispatchEvent(new TestEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {
        await flushAsync()
      })
      // Reload has not resolved yet: bob row is still mounted and focus hasn't prematurely jumped
      assert.equal(document.activeElement, bobDelete)

      await act(async () => {
        reloadGate!.resolve()
        reloadGate = null
        await flushAsync()
      })

      const carolDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete user carol')!
      assert.equal(document.activeElement, carolDelete)

      // 2. Delete last user (carol) -> focus moves to previous user (alice)'s Delete button
      await act(async () => {
        fireClick(carolDelete)
        await flushAsync()
      })
      const aliceDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete user alice')!
      assert.equal(document.activeElement, aliceDelete)

      // 3. Delete final user (alice) -> focus moves to #existing-users-heading with tabIndex=-1
      await act(async () => {
        fireClick(aliceDelete)
        await flushAsync()
      })
      const heading = container.querySelector('#existing-users-heading')!
      assert.equal(heading.getAttribute('tabindex'), '-1')
      assert.equal(document.activeElement, heading)
    } finally {
      unmount()
    }
  })

  it('Inventory: moves focus across adjacent ProductRow Delete buttons and #products-heading for both delta and reload responses', async () => {
    let productsList = [
      { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
      { id: 2, name: 'Latte', price: 4.5, stock: 20 },
      { id: 3, name: 'Mocha', price: 5.0, stock: 15 },
    ]
    let useDeltaResponse = true
    let reloadGate: ReturnType<typeof createDeferred<void>> | null = null

    api.get = (async (url: string) => {
      assert.equal(url, '/inventory')
      if (reloadGate) {
        await reloadGate.promise
      }
      return { data: [...productsList] } as any
    }) as any

    api.delete = (async (url: string) => {
      const id = Number(url.split('/').pop())
      productsList = productsList.filter(p => p.id !== id)
      return { data: useDeltaResponse ? { detail: 'Product deleted' } : {} } as any
    }) as any

    const { container, document, unmount } = render(<Inventory />)
    try {
      await act(async () => {
        await flushAsync()
      })

      // 1. Delete middle product (Latte) via authoritative delta response -> focuses Mocha's Delete
      const latteDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete Latte')!
      await act(async () => {
        fireClick(latteDelete)
        await flushAsync()
      })

      const mochaDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete Mocha')!
      assert.equal(document.activeElement, mochaDelete)

      // 2. Delete last product (Mocha) via reload fallback -> awaits GET /inventory, then focuses Espresso's Delete
      useDeltaResponse = false
      reloadGate = createDeferred<void>()
      act(() => {
        mochaDelete.focus()
        mochaDelete.dispatchEvent(new TestEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {
        await flushAsync()
      })
      assert.equal(document.activeElement, mochaDelete)

      await act(async () => {
        reloadGate!.resolve()
        reloadGate = null
        await flushAsync()
      })
      const espressoDelete = container
        .querySelectorAll('button')
        .find(b => b.textContent === 'Delete Espresso')!
      assert.equal(document.activeElement, espressoDelete)

      // 3. Delete final product (Espresso) -> focuses #products-heading with tabIndex=-1
      useDeltaResponse = true
      await act(async () => {
        fireClick(espressoDelete)
        await flushAsync()
      })
      const productsHeading = container.querySelector('#products-heading')!
      assert.equal(productsHeading.getAttribute('tabindex'), '-1')
      assert.equal(document.activeElement, productsHeading)
    } finally {
      unmount()
    }
  })
})
