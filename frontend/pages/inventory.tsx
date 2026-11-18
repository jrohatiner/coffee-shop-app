'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { useSocket } from '../hooks/useSocket'

type Product = { id: number; name: string; price: number; stock: number }

export default function Inventory(){
  const user = useAuth()
  const [products,setProducts]=useState<Product[]>([])
  const [newItem, setNewItem] = useState<{name:string;price:number;stock:number}>({name:'',price:0,stock:0})
  const [createError, setCreateError] = useState<string | null>(null)
  const [nameInvalid, setNameInvalid] = useState(false)
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({})

  const load=()=>api.get('/inventory').then(r=>setProducts(r.data))
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{
    s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() })
  })

  if(!user) return null

  const save = async (p: Product) => {
    setItemErrors((prev) => {
      const next = { ...prev }
      delete next[p.id]
      return next
    })
    try{
      await api.put(`/inventory/${p.id}`, p)
      toast({title:'Saved', description:p.name})
      load()
    } catch{
      setItemErrors((prev) => ({ ...prev, [p.id]: 'Failed to save product changes.' }))
      toast({title:'Error', description:'Failed to save', variant:'destructive'})
    }
  }

  const create = async () => {
    setCreateError(null)
    if(!newItem.name.trim()){
      setNameInvalid(true)
      setCreateError('Name required: enter a product name before adding a product.')
      toast({title:'Name required', variant:'destructive'})
      return
    }
    try{
      await api.post('/inventory', newItem)
      setNameInvalid(false)
      setCreateError(null)
      toast({title:'Product created', description:newItem.name})
      setNewItem({name:'',price:0,stock:0})
      load()
    } catch(e:any){
      const detail = e?.response?.data?.detail ?? 'Failed to create'
      setNameInvalid(true)
      setCreateError(detail)
      toast({title:'Error', description: detail, variant:'destructive'})
    }
  }

  const del = async (id:number) => {
    setItemErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try{
      await api.delete(`/inventory/${id}`)
      toast({title:'Product deleted'})
      load()
    } catch(e:any){
      const detail = e?.response?.data?.detail ?? 'Failed to delete'
      setItemErrors((prev) => ({ ...prev, [id]: detail }))
      toast({title:'Error', description: detail, variant:'destructive'})
    }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <section className="border rounded p-4 space-y-3">
        <h2 className="font-semibold text-lg">Create New Product</h2>
        <div className="grid gap-3 max-w-lg">
          <div className="space-y-1">
            <label htmlFor="new-product-name" className="block text-sm font-medium text-gray-800">
              Name
            </label>
            <Input
              id="new-product-name"
              placeholder="Name"
              value={newItem.name}
              aria-invalid={nameInvalid ? true : undefined}
              aria-describedby={createError ? 'inventory-create-error' : undefined}
              onChange={e=>setNewItem({...newItem, name:(e.target as HTMLInputElement).value})}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="new-product-price" className="block text-sm font-medium text-gray-800">
              Price
            </label>
            <Input
              id="new-product-price"
              type="number"
              placeholder="Price"
              value={newItem.price}
              onChange={e=>setNewItem({...newItem, price: parseFloat((e.target as HTMLInputElement).value || '0')})}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="new-product-stock" className="block text-sm font-medium text-gray-800">
              Stock
            </label>
            <Input
              id="new-product-stock"
              type="number"
              placeholder="Stock"
              value={newItem.stock}
              onChange={e=>setNewItem({...newItem, stock: parseInt((e.target as HTMLInputElement).value || '0')})}
            />
          </div>
          <FormErrorBanner id="inventory-create-error" message={createError} />
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
                aria-label={`${p.name} name`}
                aria-invalid={itemErrors[p.id] ? true : undefined}
                aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                defaultValue={p.name}
                onChange={e=>p.name=(e.target as HTMLInputElement).value}
              />
              <Input
                type="number"
                aria-label={`${p.name} price`}
                aria-invalid={itemErrors[p.id] ? true : undefined}
                aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                defaultValue={p.price}
                onChange={e=>p.price=parseFloat((e.target as HTMLInputElement).value)}
              />
              <Input
                type="number"
                aria-label={`${p.name} stock`}
                aria-invalid={itemErrors[p.id] ? true : undefined}
                aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                defaultValue={p.stock}
                onChange={e=>p.stock=parseInt((e.target as HTMLInputElement).value)}
              />
            </div>
            <FormErrorBanner id={`inventory-item-error-${p.id}`} message={itemErrors[p.id]} />
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
