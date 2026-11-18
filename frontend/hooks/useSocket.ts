import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export const useSocket = (onReady?: (socket:Socket)=>void) => {
  const ref = useRef<Socket|null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(()=>{
    const s = io(SOCKET_URL, { path: '/ws/' })
    ref.current = s
    onReadyRef.current && onReadyRef.current(s)
    return ()=>{ s.disconnect() }
  },[])
  return ref
}
