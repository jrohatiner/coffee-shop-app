import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { jwtDecode } from 'jwt-decode'   // ← named export in v4

type Decoded = { exp: number; sub: string }

export const useAuth = () => {
  const [user, setUser] = useState<Decoded | null>(null)
  const r = useRouter()

  useEffect(() => {
    const t = localStorage.getItem('token')
    if (!t) { r.push('/login'); return }

    try {
      const d = jwtDecode<Decoded>(t)   // ← use jwtDecode()
      if (d.exp * 1000 < Date.now()) {
        localStorage.removeItem('token')
        r.push('/login')
        return
      }
      setUser(d)
    } catch {
      // invalid token format
      localStorage.removeItem('token')
      r.push('/login')
    }
  }, [r])

  return user
}
