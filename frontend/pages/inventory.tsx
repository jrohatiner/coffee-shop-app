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
  const [nameError, setNameError] = useState('')
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({})

  const load=()=>api.get('/inventory').then(r=>setProducts(r.data)).catch(()=>{})
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{
    s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() })
  })

  if(!user) return null

  const save = async (p: Product) => {
    const missingName = !p.name.trim()
    try{
      if (missingName) {
        setItemErrors(prev => ({ ...prev, [p.id]: 'Product name is required.' }))
        throw new Error('Name required')
      }
      await api.put(`/inventory/${p.id}`, p)
      setItemErrors(prev => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })
      toast({title:'Saved', description:p.name})
      load()
    } catch{
      if (!missingName) {
        setItemErrors(prev => ({ ...prev, [p.id]: 'Failed to save product changes.' }))
      }
      toast({title:'Error', description:'Failed to save', variant:'destructive'})
    }
  }

  const create = async () => {
    if(!newItem.name.trim()){
      setNameError('Product name is required.')
      toast({title:'Name required', variant:'destructive'})
      return
    }
    try{
      await api.post('/inventory', newItem)
      setNameError('')
      toast({title:'Product created', description:newItem.name})
      setNewItem({name:'',price:0,stock:0})
      load()
    } catch(e:any){
      const detail = e?.response?.data?.detail ?? 'Failed to create'
      setNameError(typeof detail === 'string' ? detail : 'Failed to create')
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
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <section className="border rounded p-4 space-y-3">
        <h2 className="font-semibold text-lg">Create New Product</h2>
        <div className="grid gap-3 max-w-lg">
          <Input
            label="Product Name"
            placeholder="Name"
            value={newItem.name}
            error={nameError || undefined}
            onChange={e=>{
              const val = (e.target as HTMLInputElement).value
              setNewItem({...newItem, name: val})
              if (val.trim() && nameError) setNameError('')
            }}
          />
          <Input
            label="Price"
            type="number"
            placeholder="Price"
            value={newItem.price}
            onChange={e=>setNewItem({...newItem, price: parseFloat((e.target as HTMLInputElement).value || '0')})}
          />
          <Input
            label="Stock"
            type="number"
            placeholder="Stock"
            value={newItem.stock}
            onChange={e=>setNewItem({...newItem, stock: parseInt((e.target as HTMLInputElement).value || '0')})}
          />
          <Button onClick={create}>Add Product</Button>
        </div>
      </section>

      {/* Existing Products */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Products</h2>
        {products.map(p=>(
          <div key={p.id} className="border rounded p-4 space-y-2 max-w-lg">
            <div className="grid gap-2">
              <Input
                label="Product Name"
                defaultValue={p.name}
                error={itemErrors[p.id]}
                onChange={e=>{
                  const val = (e.target as HTMLInputElement).value
                  p.name = val
                  if (val.trim() && itemErrors[p.id]) {
                    setItemErrors(prev => {
                      const next = { ...prev }
                      delete next[p.id]
                      return next
                    })
                  }
                }}
              />
              <Input label="Price" type="number" defaultValue={p.price} onChange={e=>p.price=parseFloat((e.target as HTMLInputElement).value)} />
              <Input label="Stock" type="number" defaultValue={p.stock} onChange={e=>p.stock=parseInt((e.target as HTMLInputElement).value)} />
            </div>
            <div className="flex gap-2">
              <Button onClick={()=>save(p)}>Save</Button>
              <Button onClick={()=>del(p.id)}>Delete</Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
