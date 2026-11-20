'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import { formatOrderDate } from '../lib/dateFormat'
import type { DashboardSummary } from '../types/api'

export default function Dashboard() {
  const user = useAuth()
  const [summary, setSummary] = useState<DashboardSummary>({
    totalSales: 0,
    recentOrders: [],
  })
  const recentOrders = useMemo(
    () =>
      (summary?.recentOrders ?? []).map((o) => ({
        order: o,
        formattedCreatedAt: formatOrderDate(o.created_at),
      })),
    [summary?.recentOrders]
  )
  useEffect(() => {
    if (user) api.get('/dashboard/summary').then((r) => setSummary(r.data))
  }, [user])
  if (!user) return null
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Total Sales</h2>
        <div className="text-2xl">${summary.totalSales?.toFixed?.(2) ?? 0}</div>
      </div>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Recent Orders</h2>
        <ul className="list-disc ml-5">
          {recentOrders.map(({ order: o, formattedCreatedAt }) => (
            <li key={o.id}>
              #{o.id} — {o.status} — {formattedCreatedAt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
