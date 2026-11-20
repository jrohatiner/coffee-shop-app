'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import type { SalesReportOut } from '../types/api'

type ReportTab = 'daily' | 'weekly' | 'monthly'

export type SalesReport = Omit<SalesReportOut, 'created_at'> & {
  created_at?: string
}

type TabPageState = {
  items: SalesReport[]
  page: number
  hasMore: boolean
  loadedPage: number | null
}

const REPORT_TABS: readonly ReportTab[] = ['daily', 'weekly', 'monthly']
const DEFAULT_PAGE_SIZE = 20

const isReportTab = (value: string): value is ReportTab =>
  REPORT_TABS.some((period) => period === value)

const createInitialTabStates = (): Record<ReportTab, TabPageState> => ({
  daily: { items: [], page: 1, hasMore: false, loadedPage: null },
  weekly: { items: [], page: 1, hasMore: false, loadedPage: null },
  monthly: { items: [], page: 1, hasMore: false, loadedPage: null },
})

const isCanceledRequest = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const record = err as Record<string, unknown>
  return (
    record.name === 'CanceledError' ||
    record.name === 'AbortError' ||
    record.code === 'ERR_CANCELED' ||
    record.__CANCEL__ === true
  )
}

export const ReportsPagination = memo(function ReportsPagination({
  page,
  reportsCount,
  hasMore,
  onPrevPage,
  onNextPage,
}: {
  page: number
  reportsCount: number
  hasMore: boolean
  onPrevPage: () => void
  onNextPage: () => void
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <div className="text-sm text-gray-600">
        Page {page} · Showing {reportsCount}{' '}
        {reportsCount === 1 ? 'report' : 'reports'}
      </div>
      <div className="flex items-center gap-2">
        <Button
          disabled={page <= 1}
          className="disabled:opacity-50 disabled:pointer-events-none"
          onClick={onPrevPage}
        >
          Previous
        </Button>
        <Button
          disabled={!hasMore}
          className="disabled:opacity-50 disabled:pointer-events-none"
          onClick={onNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  )
})

export default function Reports() {
  const user = useAuth()
  const userKey = user ? (user.sub ?? true) : null
  const [tab, setTab] = useState<ReportTab>('daily')
  const [tabStates, setTabStates] = useState<Record<ReportTab, TabPageState>>(
    createInitialTabStates
  )

  const requestSeqRef = useRef(0)
  const tabStatesRef = useRef(tabStates)
  tabStatesRef.current = tabStates

  const activePage = tabStates[tab].page

  useEffect(() => {
    const seq = ++requestSeqRef.current
    if (!userKey) return
    if (tabStatesRef.current[tab].loadedPage === activePage) return

    let settled = false
    const controller = new AbortController()
    const targetTab = tab
    const targetPage = activePage
    const offset = (targetPage - 1) * DEFAULT_PAGE_SIZE

    Promise.resolve(
      api.get<SalesReport[]>(`/reports/${targetTab}`, {
        params: { limit: DEFAULT_PAGE_SIZE, offset },
        signal: controller.signal,
      })
    )
      .then((r) => {
        settled = true
        if (controller.signal.aborted || seq !== requestSeqRef.current) return
        const data: SalesReport[] = Array.isArray(r?.data) ? r.data : []
        const headerHasMore =
          r?.headers?.['x-has-more'] ?? r?.headers?.['X-Has-More']
        const more =
          headerHasMore !== undefined
            ? String(headerHasMore).toLowerCase() === 'true'
            : data.length === DEFAULT_PAGE_SIZE
        setTabStates((prev) => ({
          ...prev,
          [targetTab]: {
            ...prev[targetTab],
            items: data,
            hasMore: more,
            loadedPage: targetPage,
          },
        }))
      })
      .catch((err: unknown) => {
        settled = true
        if (
          isCanceledRequest(err) ||
          controller.signal.aborted ||
          seq !== requestSeqRef.current
        ) {
          return
        }
        toast({
          title: 'Error',
          description: 'Failed to load reports',
          variant: 'destructive',
        })
      })

    return () => {
      if (!settled) {
        controller.abort()
      }
    }
  }, [userKey, tab, activePage])

  const handleTabChange = useCallback((v: string) => {
    if (isReportTab(v)) {
      setTab(v)
    }
  }, [])

  const handlePrevPage = useCallback(() => {
    setTabStates((prev) => {
      const current = prev[tab]
      const nextPage = Math.max(1, current.page - 1)
      if (nextPage === current.page) return prev
      return {
        ...prev,
        [tab]: {
          ...current,
          page: nextPage,
        },
      }
    })
  }, [tab])

  const handleNextPage = useCallback(() => {
    setTabStates((prev) => {
      const current = prev[tab]
      if (!current.hasMore) return prev
      return {
        ...prev,
        [tab]: {
          ...current,
          page: current.page + 1,
        },
      }
    })
  }, [tab])

  if (!user) return null

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
                <ul className="mt-4 space-y-2">
                  {tabStates[period].items.map((r) => (
                    <li key={r.id} className="border rounded p-3">
                      <strong>{r.report_type.toUpperCase()}</strong> — $
                      {r.total_sales?.toFixed?.(2) ?? 0}
                    </li>
                  ))}
                </ul>
                <ReportsPagination
                  page={tabStates[period].page}
                  reportsCount={tabStates[period].items.length}
                  hasMore={tabStates[period].hasMore}
                  onPrevPage={handlePrevPage}
                  onNextPage={handleNextPage}
                />
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
