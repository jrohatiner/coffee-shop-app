'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'

type Product = { id: number; name: string; price: number; stock: number }

export default function Inventory(){
  const user = useAuth()
  const [products,setProducts]=useState<Product[]>([])
  const [newItem, setNewItem] = useState<{name:string;price:number;stock:number}>({name:'',price:0,stock:0})

  const load=()=>api.get('/inventory').then(r=>setProducts(r.data))
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{
    s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() })
  })

  if(!user) return null

  const save = async (p: Product) => {
    try{
      await api.put(`/inventory/${p.id}`, p)
      toast({title:'Saved', description:p.name})
      load()
    } catch{
      toast({title:'Error', description:'Failed to save', variant:'destructive'})
    }
  }

  const create = async () => {
    if(!newItem.name.trim()){ toast({title:'Name required', variant:'destructive'}); return }
    try{
      await api.post('/inventory', newItem)
      toast({title:'Product created', description:newItem.name})
      setNewItem({name:'',price:0,stock:0})
      load()
    } catch(e:any){
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to create', variant:'destructive'})
    }
  }

  const del = async (id:number) => {
    try{
      await api.delete(`/inventory/${id}`)
      toast({title:'Product deleted'})
      load()
    } catch(e:any){
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to delete', variant:'destructive'})
    }
  }

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <section className="border rounded p-4 space-y-3">
        <h2 className="font-semibold text-lg">Create New Product</h2>
        <div className="grid gap-3 max-w-lg">
          <Input placeholder="Name" value={newItem.name} onChange={e=>setNewItem({...newItem, name:(e.target as HTMLInputElement).value})} />
          <Input type="number" placeholder="Price" value={newItem.price} onChange={e=>setNewItem({...newItem, price: parseFloat((e.target as HTMLInputElement).value || '0')})} />
          <Input type="number" placeholder="Stock" value={newItem.stock} onChange={e=>setNewItem({...newItem, stock: parseInt((e.target as HTMLInputElement).value || '0')})} />
          <Button onClick={create}>Add Product</Button>
        </div>
      </section>

      {/* Existing Products */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Products</h2>
        {products.map(p=>(
          <div key={p.id} className="border rounded p-4 space-y-2 max-w-lg">
            <div className="grid gap-2">
              <Input defaultValue={p.name} onChange={e=>p.name=(e.target as HTMLInputElement).value} />
              <Input type="number" defaultValue={p.price} onChange={e=>p.price=parseFloat((e.target as HTMLInputElement).value)} />
              <Input type="number" defaultValue={p.stock} onChange={e=>p.stock=parseInt((e.target as HTMLInputElement).value)} />
            </div>
            <div className="flex gap-2">
              <Button onClick={()=>save(p)}>Save</Button>
              <Button onClick={()=>del(p.id)}>Delete</Button>
            </div>
          </div>
        ))}
      </section>
    </main>
  )
}
