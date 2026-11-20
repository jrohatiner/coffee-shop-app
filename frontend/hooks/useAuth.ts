import { useRouter } from 'next/router'
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { jwtDecode } from 'jwt-decode'

export type Decoded = { exp: number; sub: string }

const TOKEN_STORAGE_KEY = 'token'

let storeToken: string | null = null
const listeners = new Set<() => void>()
const decodedCache = new Map<string, Decoded>()

const emitChange = () => {
  listeners.forEach((listener) => listener())
}

const subscribeAuthStore = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const subscribeNoop = () => () => {}
const getNoopSnapshot = (): string | null => null
const getAuthStoreSnapshot = (): string | null => storeToken
const getServerAuthStoreSnapshot = (): string | null => null

const readStorageToken = (): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

const writeStorageToken = (token: string): void => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // ignore storage write failures
  }
}

const removeStorageToken = (): void => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // ignore storage removal failures
  }
}

const getStandaloneSnapshot = (): string | null => {
  if (typeof localStorage !== 'undefined') {
    return readStorageToken()
  }
  return storeToken
}

const decodeValidCachedToken = (rawToken: string | null): Decoded | null => {
  if (!rawToken) return null

  const cached = decodedCache.get(rawToken)
  if (cached) {
    if (cached.exp * 1000 <= Date.now()) {
      decodedCache.delete(rawToken)
      return null
    }
    return cached
  }

  try {
    const decoded = jwtDecode<Decoded>(rawToken)
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      typeof decoded.exp !== 'number' ||
      typeof decoded.sub !== 'string' ||
      decoded.exp * 1000 <= Date.now()
    ) {
      return null
    }
    decodedCache.set(rawToken, decoded)
    return decoded
  } catch {
    return null
  }
}

const updateStoreToken = (nextToken: string | null): void => {
  if (storeToken !== nextToken) {
    storeToken = nextToken
    emitChange()
  }
}

export const clearAuthToken = (): void => {
  removeStorageToken()
  updateStoreToken(null)
}

export const setAuthToken = (token: string | null): void => {
  if (!token) {
    clearAuthToken()
    return
  }

  const decoded = decodeValidCachedToken(token)
  if (!decoded) {
    clearAuthToken()
    return
  }

  writeStorageToken(token)
  updateStoreToken(token)
}

const syncAuthStoreFromStorage = (
  overrideToken?: string | null
): Decoded | null => {
  const rawToken =
    overrideToken !== undefined ? overrideToken : readStorageToken()
  if (!rawToken) {
    if (overrideToken === null) {
      removeStorageToken()
    }
    updateStoreToken(null)
    return null
  }

  const decoded = decodeValidCachedToken(rawToken)
  if (!decoded) {
    removeStorageToken()
    updateStoreToken(null)
    return null
  }

  if (overrideToken !== undefined && readStorageToken() !== rawToken) {
    writeStorageToken(rawToken)
  }
  updateStoreToken(rawToken)
  return decoded
}

type AuthContextValue = {
  user: Decoded | null
  hydrated: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [hydrated, setHydrated] = useState(false)
  const rawToken = useSyncExternalStore(
    subscribeAuthStore,
    getAuthStoreSnapshot,
    getServerAuthStoreSnapshot
  )

  useEffect(() => {
    syncAuthStoreFromStorage()
    setHydrated(true)

    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return
    }

    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== undefined &&
        event.key !== null &&
        event.key !== TOKEN_STORAGE_KEY
      ) {
        return
      }
      if (
        event.key === TOKEN_STORAGE_KEY &&
        'newValue' in event &&
        event.newValue !== undefined
      ) {
        syncAuthStoreFromStorage(event.newValue)
      } else {
        syncAuthStoreFromStorage()
      }
    }

    const targetWindow = window
    targetWindow.addEventListener('storage', handleStorage)
    return () => {
      if (typeof targetWindow.removeEventListener === 'function') {
        targetWindow.removeEventListener('storage', handleStorage)
      }
    }
  }, [])

  const user = hydrated ? decodeValidCachedToken(rawToken) : null

  const contextValue = useMemo<AuthContextValue>(
    () => ({ user, hydrated }),
    [user, hydrated]
  )

  return React.createElement(
    AuthContext.Provider,
    { value: contextValue },
    children
  )
}

export const useAuth = (): Decoded | null => {
  const context = useContext(AuthContext)
  const r = useRouter()
  const routerRef = useRef(r)
  routerRef.current = r
  const hasRedirectedRef = useRef(false)

  const hasProvider = context !== null
  const standaloneRawToken = useSyncExternalStore(
    hasProvider ? subscribeNoop : subscribeAuthStore,
    hasProvider ? getNoopSnapshot : getStandaloneSnapshot,
    getServerAuthStoreSnapshot
  )

  const isReady = hasProvider ? context.hydrated : true
  const user = hasProvider
    ? context.user
    : decodeValidCachedToken(standaloneRawToken)

  useEffect(() => {
    if (user) {
      hasRedirectedRef.current = false
      if (!hasProvider) {
        syncAuthStoreFromStorage()
      }
      return
    }

    if (!isReady) {
      return
    }

    const reconciled = syncAuthStoreFromStorage()
    if (!reconciled && !hasRedirectedRef.current) {
      hasRedirectedRef.current = true
      if (routerRef.current?.pathname !== '/login') {
        routerRef.current?.push('/login')
      }
    }
  }, [hasProvider, isReady, user, standaloneRawToken])

  return user
}
