'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Button from '../components/ui/Button'
import { Table } from '../components/ui/Table'
import OrderDetailModal from '../components/OrderDetailModal'
import { useSocket } from '../hooks/useSocket'

export default function Orders(){
  const user = useAuth()
  const [orders,setOrders]=useState<any[]>([])
  const [selected,setSelected]=useState<any|null>(null)
  const fetchOrders=()=>api.get('/orders').then(r=>setOrders(r.data)).catch(()=>toast({title:'Error', description:'Failed to load orders', variant:'destructive'}))
  useEffect(()=>{ if(user) fetchOrders() },[user])
  useSocket(s=>{ s.on('new_order', ()=>{ toast({title:'New Order'}); fetchOrders() }) })
  if(!user) return null
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>
      <Table>
        <thead><tr><th>ID</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
        <tbody>
          {orders.map(o=>(
            <tr key={o.id}>
              <td>{o.id}</td><td>{o.status}</td><td>{new Date(o.created_at).toLocaleString()}</td>
              <td><Button onClick={()=>setSelected(o)}>View</Button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      {selected && <OrderDetailModal order={selected} onClose={()=>setSelected(null)} />}
    </main>
  )
}
