'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'

export type Product = { id: number; name: string; price: number; stock: number }

export const CreateProductForm = memo(function CreateProductForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const [newItem, setNewItem] = useState<{ name: string; price: number; stock: number }>({
    name: '',
    price: 0,
    stock: 0,
  })

  const create = async () => {
    if (!newItem.name.trim()) {
      toast({ title: 'Name required', variant: 'destructive' })
      return
    }
    try {
      await api.post('/inventory', newItem)
      toast({ title: 'Product created', description: newItem.name })
      setNewItem({ name: '', price: 0, stock: 0 })
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
          placeholder="Name"
          value={newItem.name}
          onChange={e =>
            setNewItem(prev => ({ ...prev, name: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          type="number"
          placeholder="Price"
          value={newItem.price}
          onChange={e => {
            const nextPrice = parseFloat((e.target as HTMLInputElement).value || '0')
            setNewItem(prev => ({
              ...prev,
              price: Number.isNaN(nextPrice) ? 0 : nextPrice,
            }))
          }}
        />
        <Input
          type="number"
          placeholder="Stock"
          value={newItem.stock}
          onChange={e => {
            const nextStock = parseInt((e.target as HTMLInputElement).value || '0', 10)
            setNewItem(prev => ({
              ...prev,
              stock: Number.isNaN(nextStock) ? 0 : nextStock,
            }))
          }}
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
  const [draft, setDraft] = useState<{ name: string; price: number; stock: number }>({
    name: product.name,
    price: product.price,
    stock: product.stock,
  })

  useEffect(() => {
    setDraft({
      name: product.name,
      price: product.price,
      stock: product.stock,
    })
  }, [product])

  const productLabel = draft.name.trim() || `Product #${product.id}`

  return (
    <fieldset className="min-w-0 border rounded p-4 space-y-2 max-w-lg">
      <legend className="px-1 font-medium">{productLabel}</legend>
      <div className="grid gap-2">
        <Input
          value={draft.name}
          onChange={e =>
            setDraft(prev => ({ ...prev, name: (e.target as HTMLInputElement).value }))
          }
        />
        <Input
          type="number"
          value={draft.price}
          onChange={e => {
            const nextPrice = parseFloat((e.target as HTMLInputElement).value || '0')
            setDraft(prev => ({
              ...prev,
              price: Number.isNaN(nextPrice) ? 0 : nextPrice,
            }))
          }}
        />
        <Input
          type="number"
          value={draft.stock}
          onChange={e => {
            const nextStock = parseInt((e.target as HTMLInputElement).value || '0', 10)
            setDraft(prev => ({
              ...prev,
              stock: Number.isNaN(nextStock) ? 0 : nextStock,
            }))
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button contextLabel={productLabel} onClick={() => onSave({ ...product, ...draft })}>
          Save
        </Button>
        <Button contextLabel={productLabel} onClick={() => onDelete(product.id)}>
          Delete
        </Button>
      </div>
    </fieldset>
  )
})

export default function Inventory() {
  const user = useAuth()
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

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <CreateProductForm onCreated={load} />

      {/* Existing Products */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Products</h2>
        {products.map(p => (
          <ProductRow key={p.id} product={p} onSave={save} onDelete={del} />
        ))}
      </section>
    </div>
  )
}
