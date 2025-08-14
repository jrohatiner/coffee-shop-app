'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'

export default function Inventory(){
  const user = useAuth()
  const [products,setProducts]=useState<any[]>([])
  const load=()=>api.get('/inventory').then(r=>setProducts(r.data))
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{ s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() }) })
  if(!user) return null
  const save = async (p:any) => {
    try{ await api.put(`/inventory/${p.id}`, p); toast({title:'Saved', description:p.name}) ; load() }
    catch{ toast({title:'Error', description:'Failed to save', variant:'destructive'}) }
  }
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Inventory</h1>
      {products.map(p=>(
        <div key={p.id} className="border rounded p-4 space-y-2">
          <Input defaultValue={p.name} onChange={e=>p.name=(e.target as HTMLInputElement).value} />
          <Input type="number" defaultValue={p.price} onChange={e=>p.price=parseFloat((e.target as HTMLInputElement).value)} />
          <Input type="number" defaultValue={p.stock} onChange={e=>p.stock=parseInt((e.target as HTMLInputElement).value)} />
          <Button onClick={()=>save(p)}>Save</Button>
        </div>
      ))}
    </main>
  )
}
