import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, it } from 'node:test'
import React, { Profiler } from 'react'
import { renderToString } from 'react-dom/server'
import TestRenderer, { act } from 'react-test-renderer'
import Navbar from '../components/Navbar'
import {
  AuthProvider,
  clearAuthToken,
  Decoded,
  setAuthToken,
  useAuth,
} from '../hooks/useAuth'
import api from '../lib/api'
import Dashboard from '../pages/dashboard'
import Inventory from '../pages/inventory'
import Login from '../pages/login'
import Orders from '../pages/orders'
import Reports from '../pages/reports'
import Users from '../pages/users'

const requireModule = createRequire(__filename)
const routerModule = requireModule('next/router')
const socketIoModule = requireModule('socket.io-client')

function makeJwt(sub = 'manager@coffee.test', expOffsetSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AuthProvider and cached token store', () => {
  let prevUseRouter: any
  let prevIo: any
  let prevApiGet: any
  let prevApiPost: any
  let prevLocalStorage: any
  let prevWindow: any
  let prevSelf: any
  let hasPrevWindow = false
  let hasPrevLocalStorage = false
  let hasPrevSelf = false

  let currentRouter: {
    pathname: string
    query?: Record<string, string>
    push: (url: string) => Promise<boolean>
  }
  let pushedRoutes: string[]
  let apiGetCalls: string[]
  let socketConnections: number
  let storage: ReturnType<typeof createMemoryStorage>

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

    prevUseRouter = routerModule.useRouter
    prevIo = socketIoModule.io
    prevApiGet = api.get
    prevApiPost = api.post

    hasPrevLocalStorage = 'localStorage' in globalThis
    prevLocalStorage = (globalThis as any).localStorage
    hasPrevWindow = 'window' in globalThis
    prevWindow = (globalThis as any).window
    hasPrevSelf = 'self' in globalThis
    prevSelf = (globalThis as any).self

    pushedRoutes = []
    apiGetCalls = []
    socketConnections = 0
    storage = createMemoryStorage()
    ;(globalThis as any).localStorage = storage

    currentRouter = {
      pathname: '/dashboard',
      query: {},
      push: (url: string) => {
        pushedRoutes.push(url)
        return Promise.resolve(true)
      },
    }

    routerModule.useRouter = () => currentRouter
    socketIoModule.io = () => {
      socketConnections += 1
      return {
        on: () => {},
        disconnect: () => {},
      }
    }

    api.get = (async (url: string) => {
      apiGetCalls.push(url)
      if (url === '/dashboard/summary') {
        return { data: { totalSales: 42, recentOrders: [] } } as any
      }
      if (url === '/orders') {
        return { data: [], headers: { 'x-has-more': 'false' } } as any
      }
      if (url === '/inventory') {
        return { data: [] } as any
      }
      if (url.startsWith('/reports/')) {
        return { data: [] } as any
      }
      if (url === '/users') {
        return { data: [] } as any
      }
      return { data: [] } as any
    }) as any

    clearAuthToken()
  })

  afterEach(() => {
    clearAuthToken()
    routerModule.useRouter = prevUseRouter
    socketIoModule.io = prevIo
    api.get = prevApiGet
    api.post = prevApiPost

    if (hasPrevLocalStorage) {
      ;(globalThis as any).localStorage = prevLocalStorage
    } else {
      delete (globalThis as any).localStorage
    }

    if (hasPrevWindow) {
      ;(globalThis as any).window = prevWindow
    } else {
      delete (globalThis as any).window
    }

    if (hasPrevSelf) {
      ;(globalThis as any).self = prevSelf
    } else {
      delete (globalThis as any).self
    }
  })

  it('returns null during initial client hydration before mount effects, then restores user', async () => {
    storage.setItem('token', makeJwt('barista@coffee.test'))
    currentRouter.pathname = '/orders'

    const renderSnapshots: Array<Decoded | null> = []
    function HydrationProbe() {
      const user = useAuth()
      renderSnapshots.push(user)
      return <Orders />
    }

    // Without act(), TestRenderer.create executes only the initial hydration render pass
    // before passive mount effects run, proving initial client render returns null to match SSR
    const renderer = TestRenderer.create(
      <AuthProvider>
        <HydrationProbe />
      </AuthProvider>
    )
    assert.equal(renderer.toJSON(), null)
    assert.deepEqual(renderSnapshots, [null])

    // Flushing passive mount effects completes AuthProvider hydration and restores user
    await act(async () => {
      await flushPromises()
    })

    assert.notEqual(renderer.toJSON(), null)
    assert.equal(renderSnapshots[renderSnapshots.length - 1]?.sub, 'barista@coffee.test')
    assert.deepEqual(apiGetCalls, ['/orders', '/inventory'])
    assert.equal(socketConnections, 1)

    await act(async () => {
      renderer.unmount()
    })
  })

  it('supplies user synchronously on commit one across all 5 protected pages and starts 6 GETs + 2 sockets on commit one', async () => {
    storage.setItem('token', makeJwt('staff@coffee.test'))

    const routes: Array<{ path: string; Comp: React.ComponentType }> = [
      { path: '/dashboard', Comp: Dashboard },
      { path: '/orders', Comp: Orders },
      { path: '/inventory', Comp: Inventory },
      { path: '/reports', Comp: Reports },
      { path: '/users', Comp: Users },
    ]

    let nullCommitOneCount = 0
    let commitOneGetCalls = 0
    let commitOneSockets = 0

    // Mount AuthProvider on /login first so hydration finishes before navigating protected pages
    currentRouter.pathname = '/login'
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <AuthProvider>
          <div data-page="login" />
        </AuthProvider>
      )
      await flushPromises()
    })

    apiGetCalls = []
    socketConnections = 0

    for (const { path, Comp } of routes) {
      currentRouter = {
        pathname: path,
        query: {},
        push: (url: string) => {
          pushedRoutes.push(url)
          return Promise.resolve(true)
        },
      }

      let mountCommits = 0
      const getsBefore = apiGetCalls.length
      const socketsBefore = socketConnections

      await act(async () => {
        renderer.update(
          <AuthProvider>
            <Profiler
              key={path}
              id={path}
              onRender={(_id, phase) => {
                if (phase === 'mount') {
                  mountCommits += 1
                }
              }}
            >
              <Comp />
            </Profiler>
          </AuthProvider>
        )
      })

      assert.equal(mountCommits, 1, `Expected single mount commit for ${path}`)
      if (renderer.toJSON() === null) {
        nullCommitOneCount += 1
      }
      commitOneGetCalls += apiGetCalls.length - getsBefore
      commitOneSockets += socketConnections - socketsBefore

      await act(async () => {
        await flushPromises()
      })
    }

    assert.equal(nullCommitOneCount, 0)
    assert.equal(commitOneGetCalls, 6)
    assert.equal(commitOneSockets, 2)
    assert.equal(pushedRoutes.length, 0)

    renderer.unmount()
  })

  it('reuses cached Decoded reference and triggers zero duplicate api.get calls across 3 useRouter() updates per page', async () => {
    storage.setItem('token', makeJwt('manager@coffee.test'))

    const capturedUsers: Array<Decoded | null> = []
    function UserSpy({ children }: { children: React.ReactNode }) {
      const u = useAuth()
      capturedUsers.push(u)
      return <>{children}</>
    }

    const routes: Array<{ path: string; Comp: React.ComponentType }> = [
      { path: '/dashboard', Comp: Dashboard },
      { path: '/orders', Comp: Orders },
      { path: '/inventory', Comp: Inventory },
      { path: '/reports', Comp: Reports },
      { path: '/users', Comp: Users },
    ]

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <AuthProvider>
          <div />
        </AuthProvider>
      )
      await flushPromises()
    })

    for (const { path, Comp } of routes) {
      currentRouter = {
        pathname: path,
        query: { rev: '0' },
        push: (url: string) => {
          pushedRoutes.push(url)
          return Promise.resolve(true)
        },
      }

      await act(async () => {
        renderer.update(
          <AuthProvider>
            <UserSpy>
              <Comp />
            </UserSpy>
          </AuthProvider>
        )
        await flushPromises()
      })

      const initialGetCount = apiGetCalls.length

      for (let updateIdx = 1; updateIdx <= 3; updateIdx++) {
        currentRouter = {
          pathname: path,
          query: { rev: String(updateIdx) },
          push: (url: string) => {
            pushedRoutes.push(url)
            return Promise.resolve(true)
          },
        }
        await act(async () => {
          renderer.update(
            <AuthProvider>
              <UserSpy>
                <Comp />
              </UserSpy>
            </AuthProvider>
          )
          await flushPromises()
        })
      }

      // Zero duplicate api.get requests across 3 router updates
      assert.equal(
        apiGetCalls.length,
        initialGetCount,
        `Expected 0 duplicate api.get calls on ${path}`
      )
    }

    assert.ok(capturedUsers.length >= 20)
    const uniqueDecodedRefs = new Set(capturedUsers)
    assert.equal(uniqueDecodedRefs.size, 1)
    assert.equal([...uniqueDecodedRefs][0]?.sub, 'manager@coffee.test')

    renderer.unmount()
  })

  it('updates AuthProvider immediately on Login setAuthToken, Navbar clearAuthToken, and window storage events', async () => {
    const storageListeners = new Set<(event: any) => void>()
    const mockWin = {
      setTimeout,
      clearTimeout,
      addEventListener: (type: string, cb: (event: any) => void) => {
        if (type === 'storage') storageListeners.add(cb)
      },
      removeEventListener: (type: string, cb: (event: any) => void) => {
        if (type === 'storage') storageListeners.delete(cb)
      },
    }
    ;(globalThis as any).window = mockWin
    ;(globalThis as any).self = mockWin

    const signedInToken = makeJwt('alice@coffee.test')
    api.post = (async (url: string) => {
      assert.equal(url, '/auth/token')
      return { data: { access_token: signedInToken } } as any
    }) as any

    currentRouter.pathname = '/login'
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <AuthProvider>
          <Login />
        </AuthProvider>
      )
      await flushPromises()
    })

    const form = renderer.root.findByType('form')
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} })
      await flushPromises()
    })

    assert.equal(storage.getItem('token'), signedInToken)
    assert.deepEqual(pushedRoutes, ['/dashboard'])

    // Navigating to Dashboard renders immediately on commit one without returning null
    currentRouter.pathname = '/dashboard'
    apiGetCalls = []
    await act(async () => {
      renderer.update(
        <AuthProvider>
          <Navbar />
          <Dashboard />
        </AuthProvider>
      )
    })
    assert.notEqual(renderer.toJSON(), null)
    assert.deepEqual(apiGetCalls, ['/dashboard/summary'])

    // Clicking Logout in Navbar calls clearAuthToken and updates AuthProvider immediately
    pushedRoutes = []
    const logoutBtn = renderer.root
      .findAllByType('button')
      .find((b) => b.children.includes('Logout'))
    assert.ok(logoutBtn, 'Expected Logout button in Navbar')

    await act(async () => {
      logoutBtn.props.onClick()
      await flushPromises()
    })

    assert.equal(storage.getItem('token'), null)
    assert.ok(pushedRoutes.includes('/login'))

    // Re-seed via setAuthToken, then clear in another tab via window storage event
    const secondToken = makeJwt('bob@coffee.test')
    await act(async () => {
      setAuthToken(secondToken)
    })

    let observedUser: Decoded | null = null
    function Reader() {
      observedUser = useAuth()
      return null
    }

    await act(async () => {
      renderer.update(
        <AuthProvider>
          <Reader />
        </AuthProvider>
      )
    })
    assert.equal((observedUser as Decoded | null)?.sub, 'bob@coffee.test')

    // Simulate another tab clearing token
    storage.removeItem('token')
    pushedRoutes = []
    await act(async () => {
      storageListeners.forEach((fn) => fn({ key: 'token', newValue: null }))
      await flushPromises()
    })
    assert.equal(observedUser, null)
    assert.deepEqual(pushedRoutes, ['/login'])

    renderer.unmount()
  })

  it('clears localStorage and redirects to /login once without loops for missing, expired, or malformed tokens', async () => {
    const cases: Array<{ label: string; token: string | null }> = [
      { label: 'missing', token: null },
      { label: 'expired', token: makeJwt('expired@coffee.test', -60) },
      { label: 'malformed', token: 'not.a.valid-jwt' },
    ]

    for (const { label, token } of cases) {
      clearAuthToken()
      storage.clear()
      if (token !== null) {
        storage.setItem('token', token)
      }
      pushedRoutes = []
      apiGetCalls = []
      currentRouter = {
        pathname: '/orders',
        query: {},
        push: (url: string) => {
          pushedRoutes.push(url)
          return Promise.resolve(true)
        },
      }

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(
          <AuthProvider>
            <Orders />
          </AuthProvider>
        )
        await flushPromises()
      })

      assert.equal(renderer.toJSON(), null, `Expected null render for ${label} token`)
      assert.equal(storage.getItem('token'), null, `Expected localStorage cleared for ${label}`)
      assert.deepEqual(pushedRoutes, ['/login'], `Expected single redirect for ${label}`)
      assert.equal(apiGetCalls.length, 0, `Expected 0 API calls for ${label}`)

      // Triggering router updates must not cause duplicate redirect loops
      currentRouter = { ...currentRouter, query: { retry: '1' } }
      await act(async () => {
        renderer.update(
          <AuthProvider>
            <Orders />
          </AuthProvider>
        )
        await flushPromises()
      })
      assert.deepEqual(pushedRoutes, ['/login'], `Expected no redirect loop for ${label}`)

      renderer.unmount()
    }
  })

  it('reconciles localStorage into the token store when pages mount standalone outside AuthProvider without window', async () => {
    delete (globalThis as any).window
    storage.setItem('token', makeJwt('standalone@coffee.test'))
    currentRouter.pathname = '/dashboard'

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Dashboard />)
    })

    // Commit one resolves user synchronously without AuthProvider and starts GET /dashboard/summary
    assert.notEqual(renderer.toJSON(), null)
    assert.deepEqual(apiGetCalls, ['/dashboard/summary'])

    renderer.unmount()

    // Now test standalone mount with an expired token invokes fakeRouter.push via ref
    storage.setItem('token', makeJwt('expired-standalone@coffee.test', -120))
    pushedRoutes = []
    apiGetCalls = []

    await act(async () => {
      renderer = TestRenderer.create(<Dashboard />)
      await flushPromises()
    })

    assert.equal(renderer.toJSON(), null)
    assert.equal(storage.getItem('token'), null)
    assert.deepEqual(pushedRoutes, ['/login'])
    assert.equal(apiGetCalls.length, 0)

    await act(async () => {
      renderer.unmount()
    })
  })

  it('returns null during server-side rendering when localStorage and window are undefined', () => {
    delete (globalThis as any).localStorage
    delete (globalThis as any).window
    currentRouter.pathname = '/orders'

    assert.equal(
      renderToString(
        <AuthProvider>
          <Orders />
        </AuthProvider>
      ),
      ''
    )
    assert.equal(renderToString(<Dashboard />), '')
  })
})
