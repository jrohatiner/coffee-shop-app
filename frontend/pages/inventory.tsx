'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'
import { FocusHandoffHandle, useFocusHandoff } from '../hooks/useFocusHandoff'
import {
  hasDeleteDetail,
  parseStockDelta,
  ProductItem,
  reconcileProductsDelta,
  toProductItem,
} from '../lib/orderState'

export type Product = ProductItem

const LOCAL_SOCKET_ECHO_TTL_MS = 1500

export const CreateProductForm = memo(function CreateProductForm({
  onCreated,
  onSubmitCreate,
}: {
  onCreated: (created?: unknown) => void
  onSubmitCreate?: (payload: { name: string; price: number; stock: number }) => Promise<void>
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
    const payload = {
      name: newItem.name,
      price: Number.isNaN(parsedPrice) ? 0 : parsedPrice,
      stock: Number.isNaN(parsedStock) ? 0 : parsedStock,
    }
    try {
      if (onSubmitCreate) {
        await onSubmitCreate(payload)
      } else {
        const res = await api.post('/inventory', payload)
        onCreated(res?.data)
      }
      toast({ title: 'Product created', description: newItem.name })
      setNewItem({ name: '', price: '', stock: '' })
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
  onRegisterDeleteButton,
}: {
  product: Product
  onSave: (p: Product) => void
  onDelete: (id: number) => void
  onRegisterDeleteButton?: (id: number, el: HTMLButtonElement | null) => void
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

  const setDeleteButtonRef = useCallback(
    (el: HTMLButtonElement | null) => {
      onRegisterDeleteButton?.(product.id, el)
    },
    [onRegisterDeleteButton, product.id]
  )

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
        <Button
          ref={setDeleteButtonRef}
          type="button"
          contextLabel={productLabel}
          onClick={() => onDelete(product.id)}
        >
          Delete
        </Button>
      </div>
    </fieldset>
  )
})

export default function Inventory() {
  const user = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const productsRef = useRef<Product[]>(products)
  productsRef.current = products
  const productsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const deleteButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const activeDeleteHandoffIdsRef = useRef<Set<number>>(new Set())
  const pendingLocalStockRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const { prepareFocusHandoff } = useFocusHandoff()

  const registerDeleteButton = useCallback((id: number, el: HTMLButtonElement | null) => {
    if (el) {
      deleteButtonRefs.current.set(id, el)
    } else {
      deleteButtonRefs.current.delete(id)
    }
  }, [])

  const buildDeleteFocusTargets = useCallback((deletedId: number, snapshot: Product[]) => {
    const deletedIdx = snapshot.findIndex(p => p.id === deletedId)
    const nextNeighborId = deletedIdx >= 0 ? snapshot[deletedIdx + 1]?.id : undefined
    const prevNeighborId = deletedIdx > 0 ? snapshot[deletedIdx - 1]?.id : undefined

    return () => {
      const currentProducts = productsRef.current
      const candidates: (HTMLElement | string | null | undefined)[] = []
      if (nextNeighborId !== undefined) {
        candidates.push(deleteButtonRefs.current.get(nextNeighborId))
      }
      if (deletedIdx >= 0 && currentProducts.length > 0) {
        const adjacentProduct =
          currentProducts[Math.min(deletedIdx, currentProducts.length - 1)]
        if (adjacentProduct) {
          candidates.push(deleteButtonRefs.current.get(adjacentProduct.id))
        }
      }
      if (prevNeighborId !== undefined) {
        candidates.push(deleteButtonRefs.current.get(prevNeighborId))
      }
      candidates.push(productsHeadingRef.current, '#products-heading')
      return candidates
    }
  }, [])

  const load = useCallback(() => {
    return api
      .get('/inventory')
      .then(r => {
        productsRef.current = r.data
        setProducts(r.data)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  useEffect(() => {
    return () => {
      activeDeleteHandoffIdsRef.current.clear()
      pendingLocalStockRef.current.forEach(t => clearTimeout(t))
      pendingLocalStockRef.current = []
    }
  }, [])

  const armLocalEchoToken = useCallback((token: ReturnType<typeof setTimeout>) => {
    const idx = pendingLocalStockRef.current.indexOf(token)
    if (idx !== -1) {
      const expiry = setTimeout(() => {
        const expIdx = pendingLocalStockRef.current.indexOf(expiry)
        if (expIdx !== -1) pendingLocalStockRef.current.splice(expIdx, 1)
      }, LOCAL_SOCKET_ECHO_TTL_MS)
      ;(expiry as any)?.unref?.()
      pendingLocalStockRef.current[idx] = expiry
    }
  }, [])

  const disarmLocalEchoToken = useCallback((token: ReturnType<typeof setTimeout>) => {
    const idx = pendingLocalStockRef.current.indexOf(token)
    if (idx !== -1) {
      clearTimeout(pendingLocalStockRef.current[idx])
      pendingLocalStockRef.current.splice(idx, 1)
    }
  }, [])

  const applyProductsDeltaWithHandoff = useCallback(
    (delta: { updated: ProductItem[]; deleted_ids: number[] }) => {
      let remoteHandoff: FocusHandoffHandle | null = null
      for (const deletedId of delta.deleted_ids) {
        if (!activeDeleteHandoffIdsRef.current.has(deletedId)) {
          const candidateHandoff = prepareFocusHandoff(
            deleteButtonRefs.current.get(deletedId),
            buildDeleteFocusTargets(deletedId, productsRef.current)
          )
          remoteHandoff = candidateHandoff
        }
      }
      setProducts(prev => {
        const next = reconcileProductsDelta(prev, delta)
        productsRef.current = next
        return next
      })
      remoteHandoff?.commit()
    },
    [buildDeleteFocusTargets, prepareFocusHandoff]
  )

  const handleSocket = useCallback(
    (s: any) => {
      s.on('stock_update', (payload?: unknown) => {
        const delta = parseStockDelta(payload)
        if (pendingLocalStockRef.current.length > 0) {
          const timer = pendingLocalStockRef.current.shift()
          if (timer) clearTimeout(timer)
          if (delta) {
            applyProductsDeltaWithHandoff(delta)
          }
          return
        }
        toast({ title: 'Inventory Changed' })
        if (delta) {
          applyProductsDeltaWithHandoff(delta)
          return
        }
        load()
      })
    },
    [applyProductsDeltaWithHandoff, load]
  )
  useSocket(handleSocket, Boolean(user))

  const createProduct = useCallback(
    async (payload: { name: string; price: number; stock: number }) => {
      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.post('/inventory', payload)
        const created = toProductItem(res?.data)
        if (created) {
          armLocalEchoToken(stockEchoToken)
          setProducts(prev => {
            const next = reconcileProductsDelta(prev, { updated: [created], deleted_ids: [] })
            productsRef.current = next
            return next
          })
        } else {
          disarmLocalEchoToken(stockEchoToken)
          load()
        }
      } catch (e) {
        disarmLocalEchoToken(stockEchoToken)
        throw e
      }
    },
    [armLocalEchoToken, disarmLocalEchoToken, load]
  )

  const handleCreated = useCallback(
    (created?: unknown) => {
      const parsed = toProductItem(created)
      if (parsed) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalStockRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        ;(expiry as any)?.unref?.()
        pendingLocalStockRef.current.push(expiry)
        setProducts(prev => {
          const next = reconcileProductsDelta(prev, { updated: [parsed], deleted_ids: [] })
          productsRef.current = next
          return next
        })
        return
      }
      load()
    },
    [load]
  )

  const save = useCallback(
    async (p: Product) => {
      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.put(`/inventory/${p.id}`, p)
        const updated = toProductItem(res?.data)
        if (updated) {
          armLocalEchoToken(stockEchoToken)
          setProducts(prev => {
            const next = reconcileProductsDelta(prev, { updated: [updated], deleted_ids: [] })
            productsRef.current = next
            return next
          })
          toast({ title: 'Saved', description: updated.name })
        } else {
          disarmLocalEchoToken(stockEchoToken)
          toast({ title: 'Saved', description: p.name })
          load()
        }
      } catch {
        disarmLocalEchoToken(stockEchoToken)
        toast({ title: 'Error', description: 'Failed to save', variant: 'destructive' })
      }
    },
    [armLocalEchoToken, disarmLocalEchoToken, load]
  )

  const del = useCallback(
    async (id: number) => {
      const handoff = prepareFocusHandoff(
        deleteButtonRefs.current.get(id),
        buildDeleteFocusTargets(id, productsRef.current)
      )
      activeDeleteHandoffIdsRef.current.add(id)
      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.delete(`/inventory/${id}`)
        if (hasDeleteDetail(res?.data)) {
          armLocalEchoToken(stockEchoToken)
          setProducts(prev => {
            const next = reconcileProductsDelta(prev, { updated: [], deleted_ids: [id] })
            productsRef.current = next
            return next
          })
          activeDeleteHandoffIdsRef.current.delete(id)
          handoff.commit()
          toast({ title: 'Product deleted' })
        } else {
          disarmLocalEchoToken(stockEchoToken)
          toast({ title: 'Product deleted' })
          await load()
          activeDeleteHandoffIdsRef.current.delete(id)
          handoff.commit()
        }
      } catch (e: any) {
        activeDeleteHandoffIdsRef.current.delete(id)
        handoff.cancel()
        disarmLocalEchoToken(stockEchoToken)
        toast({
          title: 'Error',
          description: e?.response?.data?.detail ?? 'Failed to delete',
          variant: 'destructive',
        })
      }
    },
    [armLocalEchoToken, buildDeleteFocusTargets, disarmLocalEchoToken, load, prepareFocusHandoff]
  )

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <CreateProductForm onCreated={handleCreated} onSubmitCreate={createProduct} />

      {/* Existing Products */}
      <section className="space-y-3">
        <h2
          id="products-heading"
          ref={productsHeadingRef}
          tabIndex={-1}
          className="font-semibold text-lg"
        >
          Products
        </h2>
        {products.map(p => (
          <ProductRow
            key={p.id}
            product={p}
            onSave={save}
            onDelete={del}
            onRegisterDeleteButton={registerDeleteButton}
          />
        ))}
      </section>
    </div>
  )
}
