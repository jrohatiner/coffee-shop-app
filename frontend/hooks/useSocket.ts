import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
export const useSocket = (onReady?: (socket:Socket)=>void) => {
  const ref = useRef<Socket|null>(null)
  useEffect(()=>{
    const s = io('/ws', { path: '/ws/' })
    ref.current = s
    onReady && onReady(s)
    return ()=>{ s.disconnect() }
  },[onReady])
  return ref
}
