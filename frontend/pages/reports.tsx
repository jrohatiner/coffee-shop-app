'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'

export default function Reports(){
  const user = useAuth()
  const [tab,setTab]=useState<'daily'|'weekly'|'monthly'>('daily')
  const [reports,setReports]=useState<any[]>([])
  useEffect(()=>{ if(user) api.get(`/reports/${tab}`).then(r=>setReports(r.data)) },[user,tab])
  if(!user) return null
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Sales Reports</h1>
      <Tabs value={tab} onValueChange={(v)=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="daily" onClick={()=>setTab('daily')}>Daily</TabsTrigger>
          <TabsTrigger value="weekly" onClick={()=>setTab('weekly')}>Weekly</TabsTrigger>
          <TabsTrigger value="monthly" onClick={()=>setTab('monthly')}>Monthly</TabsTrigger>
        </TabsList>
        <TabsContent>
          <ul className="mt-4 space-y-2">
            {reports.map(r=>(
              <li key={r.id} className="border rounded p-3">
                <strong>{r.report_type.toUpperCase()}</strong> — ${r.total_sales?.toFixed?.(2) ?? 0}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </main>
  )
}
