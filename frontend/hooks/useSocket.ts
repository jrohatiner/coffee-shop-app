import { MutableRefObject, useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'

const getSocketOrigin = () => {
  const rawUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
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
