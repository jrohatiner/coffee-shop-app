'use client'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { clearAuthToken } from '../hooks/useAuth'
import { Button } from './ui/Button'

export default function Navbar() {
  const router = useRouter()

  const logout = () => {
    clearAuthToken()
    router.push('/login')
  }

  const navItems = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/orders', label: 'Orders' },
    { href: '/inventory', label: 'Inventory' },
    { href: '/reports', label: 'Reports' },
    { href: '/users', label: 'Users' },
  ]

  return (
    <nav
      aria-label="Primary"
      className="bg-white border-b shadow-sm px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <ul className="flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:gap-x-4">
        {navItems.map((item) => {
          const active = router.pathname === item.href
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center min-h-[24px] px-2 py-1.5 rounded-full hover:text-blue-600 ${
                  active
                    ? 'bg-blue-50 font-bold text-blue-600 underline underline-offset-4'
                    : ''
                }`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
      <Button onClick={logout}>Logout</Button>
    </nav>
  )
}
