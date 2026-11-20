import { MutableRefObject, useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'

export const getSocketOrigin = (): string | undefined => {
  const configured =
    process.env.NEXT_PUBLIC_SOCKET_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim()
  const rawUrl =
    configured ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000')

  if (!rawUrl || rawUrl.startsWith('/')) {
    return undefined
  }

  try {
    return new URL(rawUrl).origin
  } catch {
    return rawUrl.replace(/\/+$/, '')
  }
}

export const useSocket = (
  onReady?: (socket: Socket) => void,
  enabled = true
): MutableRefObject<Socket | null> => {
  const ref = useRef<Socket | null>(null)
  const onReadyRef = useRef(onReady)

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    if (!enabled) {
      ref.current = null
      return
    }
    const s = io(getSocketOrigin(), { path: '/ws/socket.io' })
    ref.current = s
    onReadyRef.current?.(s)
    return () => {
      s.disconnect()
      if (ref.current === s) {
        ref.current = null
      }
    }
  }, [enabled])
  return ref
}
