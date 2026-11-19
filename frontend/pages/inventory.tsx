'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useId, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { useSocket } from '../hooks/useSocket'

export type Product = { id: number; name: string; price: number; stock: number }

export const CreateProductForm = memo(function CreateProductForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const [newItem, setNewItem] = useState<{ name: string; price: string; stock: string }>({
    name: '',
    price: '',
    stock: '',
  })

  const create = async () => {
    if (!newItem.name.trim()) {
      toast({ title: 'Name required', variant: 'destructive' })
      return
    }
    const parsedPrice = newItem.price.trim() === '' ? 0 : parseFloat(newItem.price)
    const parsedStock = newItem.stock.trim() === '' ? 0 : parseInt(newItem.stock, 10)
    try {
      await api.post('/inventory', {
        name: newItem.name,
        price: Number.isNaN(parsedPrice) ? 0 : parsedPrice,
        stock: Number.isNaN(parsedStock) ? 0 : parsedStock,
      })
      toast({ title: 'Product created', description: newItem.name })
      setNewItem({ name: '', price: '', stock: '' })
      onCreated()
    } catch (e: any) {
      toast({
        title: 'Error',
        description: e?.response?.data?.detail ?? 'Failed to create',
        variant: 'destructive',
      })
    }
  }

  return (
    <section className="border rounded p-4 space-y-3">
      <h2 className="font-semibold text-lg">Create New Product</h2>
      <div className="grid gap-3 max-w-lg">
        <Input
          label="Name"
          placeholder="e.g. Flat White"
          value={newItem.name}
          onChange={e =>
            setNewItem(prev => ({ ...prev, name: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          label="Price"
          type="number"
          step="0.01"
          min={0}
          placeholder="e.g. 4.50"
          value={newItem.price}
          onChange={e =>
            setNewItem(prev => ({ ...prev, price: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          label="Stock"
          type="number"
          min={0}
          placeholder="e.g. 50"
          value={newItem.stock}
          onChange={e =>
            setNewItem(prev => ({ ...prev, stock: (e.target as HTMLInputElement).value }))
          }
        />
        <Button onClick={create}>Add Product</Button>
      </div>
    </section>
  )
})

export const ProductRow = memo(function ProductRow({
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

  const productLabel = product.name.trim() || `Product #${product.id}`

  return (
    <fieldset className="min-w-0 border rounded p-4 space-y-2 max-w-lg">
      <legend id={legendId} className="px-1 font-medium">
        {productLabel}
      </legend>
      <div className="grid gap-2">
        <Input
          label="Name"
          labelId={nameLabelId}
          aria-labelledby={`${legendId} ${nameLabelId}`}
          value={draft.name}
          onChange={e =>
            setDraft(prev => ({ ...prev, name: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          label="Price"
          labelId={priceLabelId}
          aria-labelledby={`${legendId} ${priceLabelId}`}
          type="number"
          step="0.01"
          value={draft.price}
          onChange={e =>
            setDraft(prev => ({ ...prev, price: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          label="Stock"
          labelId={stockLabelId}
          aria-labelledby={`${legendId} ${stockLabelId}`}
          type="number"
          value={draft.stock}
          onChange={e =>
            setDraft(prev => ({ ...prev, stock: (e.target as HTMLInputElement).value }))
          }
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" contextLabel={productLabel} onClick={handleSave}>
          Save
        </Button>
        <Button type="button" contextLabel={productLabel} onClick={() => onDelete(product.id)}>
          Delete
        </Button>
      </div>
    </fieldset>
  )
})

export default function Inventory() {
  const user = useAuth()
  const [products,setProducts]=useState<Product[]>([])
  const [newItem, setNewItem] = useState<{name:string;price:number;stock:number}>({name:'',price:0,stock:0})
  const [createError, setCreateError] = useState<string | null>(null)
  const [nameInvalid, setNameInvalid] = useState(false)
  const [nameError, setNameError] = useState('')
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({})

  const load=()=>api.get('/inventory').then(r=>setProducts(r.data)).catch(()=>{})
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{
    s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() })
  }, Boolean(user))
  const [newItem, setNewItem] = useState<{name:string;price:string;stock:string}>({name:'',price:'',stock:''})
  const [products, setProducts] = useState<Product[]>([])

  const load = useCallback(() => {
    api.get('/inventory').then(r => setProducts(r.data))
  }, [])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  const handleSocket = useCallback(
    (s: any) => {
      s.on('stock_update', () => {
        toast({ title: 'Inventory Changed' })
        load()
      })
    },
    [load]
  )
  useSocket(handleSocket, Boolean(user))

  const save = useCallback(
    async (p: Product) => {
      try {
        await api.put(`/inventory/${p.id}`, p)
        toast({ title: 'Saved', description: p.name })
        load()
      } catch {
        toast({ title: 'Error', description: 'Failed to save', variant: 'destructive' })
      }
    },
    [load]
  )

  const del = useCallback(
    async (id: number) => {
      try {
        await api.delete(`/inventory/${id}`)
        toast({ title: 'Product deleted' })
        load()
      } catch (e: any) {
        toast({
          title: 'Error',
          description: e?.response?.data?.detail ?? 'Failed to delete',
          variant: 'destructive',
        })
      }
    },
    [load]
  )
  const save = async (p: Product) => {
    setItemErrors((prev) => {
      const next = { ...prev }
      delete next[p.id]
      return next
    })
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
      setItemErrors((prev) => ({ ...prev, [p.id]: 'Failed to save product changes.' }))
      if (!missingName) {
        setItemErrors(prev => ({ ...prev, [p.id]: 'Failed to save product changes.' }))
      }
      toast({title:'Error', description:'Failed to save', variant:'destructive'})
    }
  }

  const create = async () => {
    setCreateError(null)
    if(!newItem.name.trim()){
      setNameInvalid(true)
      setCreateError('Name required: enter a product name before adding a product.')
    if(!newItem.name.trim()){
      setNameError('Product name is required.')
      toast({title:'Name required', variant:'destructive'})
      return
    }
    try{
      await api.post('/inventory', newItem)
      setNameInvalid(false)
      setCreateError(null)
      setNameError('')
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
      setNameError(typeof detail === 'string' ? detail : 'Failed to create')
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to create', variant:'destructive'})
    }
  }

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <CreateProductForm onCreated={load} />
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
            label="Name"
            placeholder="e.g. Flat White"
            value={newItem.name}
            onChange={e=>setNewItem({...newItem, name:(e.target as HTMLInputElement).value})}
          />
          <Input
            label="Price"
            type="number"
            placeholder="Price"
            value={newItem.price}
            onChange={e=>setNewItem({...newItem, price: parseFloat((e.target as HTMLInputElement).value || '0')})}
            step="0.01"
            min={0}
            placeholder="e.g. 4.50"
            value={newItem.price}
            onChange={e=>setNewItem({...newItem, price:(e.target as HTMLInputElement).value})}
          />
          <Input
            label="Stock"
            type="number"
            placeholder="Stock"
            value={newItem.stock}
            onChange={e=>setNewItem({...newItem, stock: parseInt((e.target as HTMLInputElement).value || '0')})}
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
        {products.map(p=>{
          const productLabel = p.name.trim() || `Product #${p.id}`
          return (
            <fieldset key={p.id} className="min-w-0 border rounded p-4 space-y-2 max-w-lg">
              <legend className="px-1 font-medium">{productLabel}</legend>
              <div className="grid gap-2">
                <Input
                  aria-label={`${productLabel} name`}
                  aria-invalid={itemErrors[p.id] ? true : undefined}
                  aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                  label="Product Name"
                  value={p.name}
                  error={itemErrors[p.id]}
                  onChange={e=>{
                    const val = (e.target as HTMLInputElement).value
                    updateProduct(p.id, { name: val })
                    if (val.trim() && itemErrors[p.id]) {
                      setItemErrors(prev => {
                        const next = { ...prev }
                        delete next[p.id]
                        return next
                      })
                    }
                  }}
                />
                <Input
                  label="Price"
                  type="number"
                  aria-label={`${productLabel} price`}
                  aria-invalid={itemErrors[p.id] ? true : undefined}
                  aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                  value={p.price}
                  onChange={e=>{
                    const nextPrice = parseFloat((e.target as HTMLInputElement).value || '0')
                    updateProduct(p.id, { price: Number.isNaN(nextPrice) ? 0 : nextPrice })
                  }}
                />
                <Input
                  label="Stock"
                  type="number"
                  aria-label={`${productLabel} stock`}
                  aria-invalid={itemErrors[p.id] ? true : undefined}
                  aria-describedby={itemErrors[p.id] ? `inventory-item-error-${p.id}` : undefined}
                  value={p.stock}
                  onChange={e=>{
                    const nextStock = parseInt((e.target as HTMLInputElement).value || '0', 10)
                    updateProduct(p.id, { stock: Number.isNaN(nextStock) ? 0 : nextStock })
                  }}
                />
              </div>
              <FormErrorBanner id={`inventory-item-error-${p.id}`} message={itemErrors[p.id]} />
              <div className="flex gap-2">
                <Button contextLabel={productLabel} onClick={()=>save(p)}>Save</Button>
                <Button contextLabel={productLabel} onClick={()=>del(p.id)}>Delete</Button>
              </div>
            </fieldset>
          )
        })}
        {products.map(p => (
          <ProductRow key={p.id} product={p} onSave={save} onDelete={del} />
        ))}
      </section>
    </div>
  )
}
