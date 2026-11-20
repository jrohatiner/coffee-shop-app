'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import { formatOrderDate } from '../lib/dateFormat'
import FormErrorBanner from '../components/ui/FormErrorBanner'

type DashboardSummary = {
  totalSales?: number
  recentOrders?: any[]
}

export default function Dashboard() {
  const user = useAuth()
  const username = user?.sub ?? null
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const recentOrders = useMemo(
    () =>
      (summary?.recentOrders ?? []).map((o: any) => ({
        order: o,
        formattedCreatedAt: formatOrderDate(o.created_at),
      })),
    [summary?.recentOrders]
  )

  useEffect(() => {
    if (!username) return
    let active = true
    setIsLoading(true)
    setError(null)

    api
      .get('/dashboard/summary')
      .then((r) => {
        if (!active) return
        setSummary(r.data)
        setError(null)
        setIsLoading(false)
      })
      .catch((err: any) => {
        if (!active) return
        const detail = err?.response?.data?.detail
        setSummary(null)
        setError(
          typeof detail === 'string' && detail.trim()
            ? detail
            : 'Failed to load dashboard summary'
        )
        setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [username])

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      {isLoading && (
        <div role="status" aria-live="polite" className="text-sm text-gray-700">
          Loading dashboard summary...
        </div>
      )}
      {!isLoading && error && <FormErrorBanner message={error} />}
      {!isLoading && !error && summary && (
        <>
          <div className="p-4 border rounded">
            <h2 className="font-semibold">Total Sales</h2>
            <div className="text-2xl">${summary.totalSales?.toFixed?.(2) ?? 0}</div>
          </div>
          <div className="p-4 border rounded">
            <h2 className="font-semibold">Recent Orders</h2>
            <ul className="list-disc ml-5">
              {recentOrders.map(({ order: o, formattedCreatedAt }: any) => (
                <li key={o.id}>
                  #{o.id} — {o.status} — {formattedCreatedAt}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
