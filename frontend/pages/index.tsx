import Link from 'next/link'
export default function Home(){
  return (
    <main className="p-6 space-y-2">
      <h1 className="text-3xl font-bold mb-4">Coffee Shop Admin</h1>
      <ul className="space-y-2">
        <li><Link className="underline text-blue-600" href="/dashboard">Dashboard</Link></li>
        <li><Link className="underline text-blue-600" href="/orders">Orders</Link></li>
        <li><Link className="underline text-blue-600" href="/inventory">Inventory</Link></li>
        <li><Link className="underline text-blue-600" href="/reports">Reports</Link></li>
        <li><Link className="underline text-blue-600" href="/users">User Management</Link></li>
      </ul>
    </main>
  )
}
