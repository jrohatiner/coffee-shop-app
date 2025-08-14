'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'

export default function Dashboard(){
  const user = useAuth()
  const [summary,setSummary]=useState<any>({ totalSales:0, recentOrders:[] })
  useEffect(()=>{ if(user) api.get('/dashboard/summary').then(r=>setSummary(r.data)) },[user])
  if(!user) return null
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Total Sales</h2>
        <div className="text-2xl">${summary.totalSales?.toFixed?.(2) ?? 0}</div>
      </div>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Recent Orders</h2>
        <ul className="list-disc ml-5">
          {summary.recentOrders?.map((o:any)=>(
            <li key={o.id}>#{o.id} — {o.status} — {new Date(o.created_at).toLocaleString()}</li>
          ))}
        </ul>
      </div>
    </main>
  )
}
