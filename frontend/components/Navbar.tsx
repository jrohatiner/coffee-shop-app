'use client'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { Button } from './ui/Button'

export default function Navbar() {
  const router = useRouter()

  const logout = () => {
    localStorage.removeItem('token')
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
    <nav className="bg-white border-b shadow-sm px-6 py-3 flex items-center justify-between">
      <div className="flex gap-4">
        {navItems.map((item) => {
          const active = router.pathname === item.href
          return (
            <Link key={item.href} href={item.href}>
              <span className={`hover:text-blue-600 ${active ? 'font-bold text-blue-600' : ''}`}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
      <Button onClick={logout}>Logout</Button>
    </nav>
  )
}
