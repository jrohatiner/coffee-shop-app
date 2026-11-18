'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useId, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'

type Product = { id: number; name: string; price: number; stock: number }

function ProductInventoryCard({
  product,
  onSave,
  onDelete,
}: {
  product: Product
  onSave: (p: Product) => void
  onDelete: (id: number) => void
}) {
  const baseId = useId()
  const legendId = `${baseId}-legend`
  const nameLabelId = `${baseId}-name-label`
  const priceLabelId = `${baseId}-price-label`
  const stockLabelId = `${baseId}-stock-label`

  const [draft, setDraft] = useState({
    name: product.name,
    price: String(product.price),
    stock: String(product.stock),
  })

  useEffect(() => {
    setDraft({
      name: product.name,
      price: String(product.price),
      stock: String(product.stock),
    })
  }, [product.name, product.price, product.stock])

  const handleSave = () => {
    const parsedPrice = draft.price.trim() === '' ? 0 : parseFloat(draft.price)
    const parsedStock = draft.stock.trim() === '' ? 0 : parseInt(draft.stock, 10)
    onSave({
      ...product,
      name: draft.name,
      price: Number.isNaN(parsedPrice) ? 0 : parsedPrice,
      stock: Number.isNaN(parsedStock) ? 0 : parsedStock,
    })
  }

  return (
    <fieldset className="border rounded p-4 space-y-2 max-w-lg">
      <legend id={legendId} className="px-1 font-medium">
        {product.name}
      </legend>
      <div className="grid gap-2">
        <Input
          label="Name"
          labelId={nameLabelId}
          aria-labelledby={`${legendId} ${nameLabelId}`}
          value={draft.name}
          onChange={e => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })}
        />
        <Input
          label="Price"
          labelId={priceLabelId}
          aria-labelledby={`${legendId} ${priceLabelId}`}
          type="number"
          step="0.01"
          value={draft.price}
          onChange={e => setDraft({ ...draft, price: (e.target as HTMLInputElement).value })}
        />
        <Input
          label="Stock"
          labelId={stockLabelId}
          aria-labelledby={`${legendId} ${stockLabelId}`}
          type="number"
          value={draft.stock}
          onChange={e => setDraft({ ...draft, stock: (e.target as HTMLInputElement).value })}
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={handleSave}>Save</Button>
        <Button type="button" onClick={() => onDelete(product.id)}>Delete</Button>
      </div>
    </fieldset>
  )
}

export default function Inventory(){
  const user = useAuth()
  const [products,setProducts]=useState<Product[]>([])
  const [newItem, setNewItem] = useState<{name:string;price:string;stock:string}>({name:'',price:'',stock:''})

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
    const parsedPrice = newItem.price.trim() === '' ? 0 : parseFloat(newItem.price)
    const parsedStock = newItem.stock.trim() === '' ? 0 : parseInt(newItem.stock, 10)
    try{
      await api.post('/inventory', {
        name: newItem.name,
        price: Number.isNaN(parsedPrice) ? 0 : parsedPrice,
        stock: Number.isNaN(parsedStock) ? 0 : parsedStock,
      })
      toast({title:'Product created', description:newItem.name})
      setNewItem({name:'',price:'',stock:''})
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
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <section className="border rounded p-4 space-y-3">
        <h2 className="font-semibold text-lg">Create New Product</h2>
        <div className="grid gap-3 max-w-lg">
          <Input
            label="Name"
            placeholder="e.g. Flat White"
            value={newItem.name}
            onChange={e=>setNewItem({...newItem, name:(e.target as HTMLInputElement).value})}
          />
          <Input
            label="Price"
            type="number"
            step="0.01"
            min={0}
            placeholder="e.g. 4.50"
            value={newItem.price}
            onChange={e=>setNewItem({...newItem, price:(e.target as HTMLInputElement).value})}
          />
          <Input
            label="Stock"
            type="number"
            min={0}
            placeholder="e.g. 50"
            value={newItem.stock}
            onChange={e=>setNewItem({...newItem, stock:(e.target as HTMLInputElement).value})}
          />
          <Button onClick={create}>Add Product</Button>
        </div>
      </section>

      {/* Existing Products */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Products</h2>
        {products.map(p=>(
          <ProductInventoryCard
            key={p.id}
            product={p}
            onSave={save}
            onDelete={del}
          />
        ))}
      </section>
    </div>
  )
}
