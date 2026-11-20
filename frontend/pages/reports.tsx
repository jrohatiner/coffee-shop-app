'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import type { SalesReportOut } from '../types/api'

type ReportTab = 'daily' | 'weekly' | 'monthly'

const REPORT_TABS: readonly ReportTab[] = ['daily', 'weekly', 'monthly']

const isReportTab = (value: string): value is ReportTab =>
  REPORT_TABS.some((period) => period === value)

export default function Reports() {
  const user = useAuth()
  const [tab, setTab] = useState<ReportTab>('daily')
  const [reports, setReports] = useState<SalesReportOut[]>([])
  useEffect(() => {
    if (user) api.get(`/reports/${tab}`).then((r) => setReports(r.data))
  }, [user, tab])
  if (!user) return null
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Sales Reports</h1>
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isReportTab(v)) setTab(v)
        }}
      >
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
        </TabsList>
        {REPORT_TABS.map((period) => (
          <TabsContent key={period} value={period}>
            {tab === period && (
              <ul className="mt-4 space-y-2">
                {reports.map((r) => (
                  <li key={r.id} className="border rounded p-3">
                    <strong>{r.report_type.toUpperCase()}</strong> — $
                    {r.total_sales?.toFixed?.(2) ?? 0}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
