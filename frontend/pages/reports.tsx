'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import FormErrorBanner from '../components/ui/FormErrorBanner'

type ReportTab = 'daily' | 'weekly' | 'monthly'

const REPORT_TABS: readonly ReportTab[] = ['daily', 'weekly', 'monthly']

const isReportTab = (value: string): value is ReportTab =>
  REPORT_TABS.some((period) => period === value)

export default function Reports() {
  const user = useAuth()
  const username = user?.sub ?? null
  const [tab, setTab] = useState<ReportTab>('daily')
  const [reportState, setReportState] = useState<{
    loadedTab: ReportTab | null
    rows: any[]
    error: string | null
  }>({
    loadedTab: null,
    rows: [],
    error: null,
  })

  useEffect(() => {
    if (!username) return
    let active = true
    setReportState((prev) =>
      prev.loadedTab === null && prev.rows.length === 0 && prev.error === null
        ? prev
        : { loadedTab: null, rows: [], error: null }
    )

    api
      .get(`/reports/${tab}`)
      .then((r) => {
        if (!active) return
        setReportState({
          loadedTab: tab,
          rows: Array.isArray(r.data) ? r.data : [],
          error: null,
        })
      })
      .catch((err: any) => {
        if (!active) return
        const detail = err?.response?.data?.detail
        setReportState({
          loadedTab: tab,
          rows: [],
          error:
            typeof detail === 'string' && detail.trim()
              ? detail
              : `Failed to load ${tab} sales reports`,
        })
      })

    return () => {
      active = false
    }
  }, [username, tab])

  if (!user) return null

  const isLoading = reportState.loadedTab !== tab
  const visibleReports = isLoading ? [] : reportState.rows
  const visibleError = isLoading ? null : reportState.error

  const handleTabChange = (value: string) => {
    if (isReportTab(value) && value !== tab) {
      setTab(value)
      setReportState({ loadedTab: null, rows: [], error: null })
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Sales Reports</h1>
      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
        </TabsList>
        {REPORT_TABS.map((period) => (
          <TabsContent key={period} value={period}>
            {tab === period && (
              <>
                {isLoading && (
                  <div role="status" aria-live="polite" className="mt-4 text-sm text-gray-700">
                    Loading {period} sales reports...
                  </div>
                )}
                {!isLoading && visibleError && (
                  <FormErrorBanner className="mt-4" message={visibleError} />
                )}
                {!isLoading && !visibleError && visibleReports.length === 0 && (
                  <div role="status" aria-live="polite" className="mt-4 text-sm text-gray-700">
                    No {period} sales reports available.
                  </div>
                )}
                {!isLoading && !visibleError && visibleReports.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {visibleReports.map((r) => (
                      <li key={r.id} className="border rounded p-3">
                        <strong>{r.report_type.toUpperCase()}</strong> — $
                        {r.total_sales?.toFixed?.(2) ?? 0}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
