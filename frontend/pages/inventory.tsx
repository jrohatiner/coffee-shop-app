'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { useSocket } from '../hooks/useSocket'
import type { Socket } from 'socket.io-client'
import {
  hasDeleteDetail,
  parseStockDelta,
  ProductItem,
  reconcileProductsDelta,
  toProductItem,
} from '../lib/orderState'
import { getApiErrorDetail, unrefTimer } from '../types/api'

export type Product = ProductItem

const LOCAL_SOCKET_ECHO_TTL_MS = 1500

export const CreateProductForm = memo(function CreateProductForm({
  onCreated,
  onSubmitCreate,
}: {
  onCreated: (created?: unknown) => void
  onSubmitCreate?: (payload: {
    name: string
    price: number
    stock: number
  }) => Promise<void>
}) {
  const createErrorId = useId()
  const [newItem, setNewItem] = useState<{
    name: string
    price: string
    stock: string
  }>({
    name: '',
    price: '',
    stock: '',
  })
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [createError, setCreateError] = useState<string | null>(null)

  const create = async () => {
    setCreateError(null)
    if (!newItem.name.trim()) {
      setNameError('Product name is required.')
      toast({ title: 'Name required', variant: 'destructive' })
      return
    }
    setNameError(undefined)
    const parsedPrice =
      newItem.price.trim() === '' ? 0 : parseFloat(newItem.price)
    const parsedStock =
      newItem.stock.trim() === '' ? 0 : parseInt(newItem.stock, 10)
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
    } catch (e: unknown) {
      const detail = getApiErrorDetail(e, 'Failed to create')
      setCreateError(detail)
      toast({
        title: 'Error',
        description: detail,
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
          error={nameError}
          aria-invalid={Boolean(nameError || createError) || undefined}
          aria-describedby={createError ? createErrorId : undefined}
          onChange={(e) => {
            const val = (e.target as HTMLInputElement).value
            setNewItem((prev) => ({ ...prev, name: val }))
            if (val.trim()) {
              setNameError((prev) => (prev ? undefined : prev))
            }
          }}
        />
        <Input
          label="Price"
          type="number"
          step="0.01"
          min={0}
          placeholder="e.g. 4.50"
          value={newItem.price}
          onChange={(e) =>
            setNewItem((prev) => ({
              ...prev,
              price: (e.target as HTMLInputElement).value,
            }))
          }
        />
        <Input
          label="Stock"
          type="number"
          min={0}
          placeholder="e.g. 50"
          value={newItem.stock}
          onChange={(e) =>
            setNewItem((prev) => ({
              ...prev,
              stock: (e.target as HTMLInputElement).value,
            }))
          }
        />
        <FormErrorBanner id={createErrorId} message={createError} />
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
  const [nameError, setNameError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setDraft({
      name: product.name,
      price: String(product.price),
      stock: String(product.stock),
    })
    setNameError((prev) => (prev ? undefined : prev))
  }, [product.name, product.price, product.stock])

  const handleSave = () => {
    if (!draft.name.trim()) {
      setNameError('Product name is required.')
      toast({ title: 'Name required', variant: 'destructive' })
      return
    }
    setNameError((prev) => (prev ? undefined : prev))
    const parsedPrice = draft.price.trim() === '' ? 0 : parseFloat(draft.price)
    const parsedStock =
      draft.stock.trim() === '' ? 0 : parseInt(draft.stock, 10)
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
          error={nameError}
          onChange={(e) => {
            const val = (e.target as HTMLInputElement).value
            setDraft((prev) => ({ ...prev, name: val }))
            if (val.trim()) {
              setNameError((prev) => (prev ? undefined : prev))
            }
          }}
        />
        <Input
          label="Price"
          labelId={priceLabelId}
          aria-labelledby={`${legendId} ${priceLabelId}`}
          type="number"
          step="0.01"
          value={draft.price}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              price: (e.target as HTMLInputElement).value,
            }))
          }
        />
        <Input
          label="Stock"
          labelId={stockLabelId}
          aria-labelledby={`${legendId} ${stockLabelId}`}
          type="number"
          value={draft.stock}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              stock: (e.target as HTMLInputElement).value,
            }))
          }
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" contextLabel={productLabel} onClick={handleSave}>
          Save
        </Button>
        <Button
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
  const username = user?.sub ?? null
  const [products, setProducts] = useState<Product[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)
  const pendingLocalStockRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const load = useCallback(() => {
    const seq = ++requestSeqRef.current
    setIsLoading(true)
    setLoadError(null)
    return api
      .get('/inventory')
      .then((r) => {
        if (seq !== requestSeqRef.current) return
        setProducts(r.data)
        setLoadError(null)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return
        const fallback = 'Failed to load inventory'
        const detail = getApiErrorDetail(err, fallback)
        setProducts([])
        setLoadError(detail.trim() || fallback)
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    if (username) load()
  }, [username, load])

  useEffect(() => {
    return () => {
      pendingLocalStockRef.current.forEach((t) => clearTimeout(t))
      pendingLocalStockRef.current = []
    }
  }, [])

  const armLocalEchoToken = useCallback(
    (token: ReturnType<typeof setTimeout>) => {
      const idx = pendingLocalStockRef.current.indexOf(token)
      if (idx !== -1) {
        const expiry = setTimeout(() => {
          const expIdx = pendingLocalStockRef.current.indexOf(expiry)
          if (expIdx !== -1) pendingLocalStockRef.current.splice(expIdx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        unrefTimer(expiry)
        pendingLocalStockRef.current[idx] = expiry
      }
    },
    []
  )

  const disarmLocalEchoToken = useCallback(
    (token: ReturnType<typeof setTimeout>) => {
      const idx = pendingLocalStockRef.current.indexOf(token)
      if (idx !== -1) {
        clearTimeout(pendingLocalStockRef.current[idx])
        pendingLocalStockRef.current.splice(idx, 1)
      }
    },
    []
  )

  const handleSocket = useCallback(
    (s: Socket) => {
      s.on('stock_update', (payload?: unknown) => {
        const delta = parseStockDelta(payload)
        if (pendingLocalStockRef.current.length > 0) {
          const timer = pendingLocalStockRef.current.shift()
          if (timer) clearTimeout(timer)
          if (delta) {
            setProducts((prev) => reconcileProductsDelta(prev, delta))
          }
          return
        }
        toast({ title: 'Inventory Changed' })
        if (delta) {
          setProducts((prev) => reconcileProductsDelta(prev, delta))
          return
        }
        load()
      })
    },
    [load]
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
          setLoadError(null)
          setProducts((prev) =>
            reconcileProductsDelta(prev, {
              updated: [created],
              deleted_ids: [],
            })
          )
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
        unrefTimer(expiry)
        pendingLocalStockRef.current.push(expiry)
        setLoadError(null)
        setProducts((prev) =>
          reconcileProductsDelta(prev, { updated: [parsed], deleted_ids: [] })
        )
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
          setProducts((prev) =>
            reconcileProductsDelta(prev, {
              updated: [updated],
              deleted_ids: [],
            })
          )
          toast({ title: 'Saved', description: updated.name })
        } else {
          disarmLocalEchoToken(stockEchoToken)
          toast({ title: 'Saved', description: p.name })
          load()
        }
      } catch {
        disarmLocalEchoToken(stockEchoToken)
        toast({
          title: 'Error',
          description: 'Failed to save',
          variant: 'destructive',
        })
      }
    },
    [armLocalEchoToken, disarmLocalEchoToken, load]
  )

  const del = useCallback(
    async (id: number) => {
      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.delete(`/inventory/${id}`)
        if (hasDeleteDetail(res?.data)) {
          armLocalEchoToken(stockEchoToken)
          setProducts((prev) =>
            reconcileProductsDelta(prev, { updated: [], deleted_ids: [id] })
          )
          toast({ title: 'Product deleted' })
        } else {
          disarmLocalEchoToken(stockEchoToken)
          toast({ title: 'Product deleted' })
          load()
        }
      } catch (e: unknown) {
        disarmLocalEchoToken(stockEchoToken)
        toast({
          title: 'Error',
          description: getApiErrorDetail(e, 'Failed to delete'),
          variant: 'destructive',
        })
      }
    },
    [armLocalEchoToken, disarmLocalEchoToken, load]
  )

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Inventory</h1>

      {/* Create New Product */}
      <CreateProductForm
        onCreated={handleCreated}
        onSubmitCreate={createProduct}
      />

      {/* Existing Products */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Products</h2>
        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            className="text-sm text-gray-700"
          >
            Loading inventory...
          </div>
        )}
        {!isLoading && loadError && <FormErrorBanner message={loadError} />}
        {!isLoading && !loadError && products.length === 0 && (
          <div
            role="status"
            aria-live="polite"
            className="text-sm text-gray-700"
          >
            No products in inventory.
          </div>
        )}
        {!loadError &&
          products.map((p) => (
            <ProductRow key={p.id} product={p} onSave={save} onDelete={del} />
          ))}
      </section>
    </div>
  )
}
