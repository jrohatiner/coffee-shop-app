'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Button from '../components/ui/Button'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableRowHeader,
  TableCell,
} from '../components/ui/Table'
import OrderDetailModal from '../components/OrderDetailModal'
import { useSocket } from '../hooks/useSocket'
import Input from '../components/ui/Input'

export type Product = { id: number; name: string; price: number; stock: number }
export type Order = { id: number; status: string; created_at: string; items: any[] }
type OrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export const ProductPickerRow = memo(function ProductPickerRow({
  product,
  quantity,
  onChangeQty,
}: {
  product: Product
  quantity: number
  onChangeQty: (pid: number, qty: number) => void
}) {
  return (
    <div className="flex items-center justify-between border rounded p-2">
      <div className="flex flex-col">
        <span className="font-medium">{product.name}</span>
        <span className="text-sm text-gray-600">
          ${product.price.toFixed(2)} · stock {product.stock}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm">Qty</span>
        <Input
          type="number"
          min={0}
          value={quantity}
          onChange={e =>
            onChangeQty(product.id, parseInt((e.target as HTMLInputElement).value || '0', 10))
          }
          className="w-20"
        />
      </div>
    </div>
  )
})

export const OrderCreator = memo(function OrderCreator({
  products,
  onOrderCreated,
}: {
  products: Product[]
  onOrderCreated: () => void
}) {
  const [cart, setCart] = useState<Record<number, number>>({})
  const [status, setStatus] = useState<OrderStatus>('pending')

  const productById = useMemo(() => {
    const map = new Map<number, Product>()
    for (const p of products) map.set(p.id, p)
    return map
  }, [products])

  const setQty = useCallback((pid: number, qty: number) => {
    const normalizedQty = Number.isNaN(qty) ? 0 : qty
    setCart(prev => {
      if (normalizedQty <= 0) {
        if (!(pid in prev)) return prev
        const next = { ...prev }
        delete next[pid]
        return next
      }
      if (prev[pid] === normalizedQty) return prev
      return { ...prev, [pid]: normalizedQty }
    })
  }, [])

  const createOrder = async () => {
    const items = Object.entries(cart).map(([product_id, quantity]) => ({
      product_id: Number(product_id),
      quantity: Number(quantity),
    }))
    if (items.length === 0) {
      toast({ title: 'Add at least one item', variant: 'destructive' })
      return
    }
    try {
      await api.post('/orders', { status, items })
      toast({ title: 'Order created' })
      setCart({})
      setStatus('pending')
      onOrderCreated()
    } catch (e: any) {
      toast({
        title: 'Error',
        description: e?.response?.data?.detail ?? 'Failed to create order',
        variant: 'destructive',
      })
    }
  }

  return (
    <section className="border rounded p-4 space-y-3 max-w-3xl">
      <h2 className="font-semibold text-lg">Create New Order</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="font-medium">Pick Products</div>
          <div className="space-y-2 max-h-80 overflow-auto pr-2">
            {products.map(p => (
              <ProductPickerRow
                key={p.id}
                product={p}
                quantity={cart[p.id] ?? 0}
                onChangeQty={setQty}
              />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="font-medium">Order Status</div>
          <select
            className="border rounded px-3 py-2"
            value={status}
            onChange={e => setStatus(e.target.value as OrderStatus)}
          >
            <option value="pending">pending</option>
            <option value="in_progress">in_progress</option>
            <option value="completed">completed</option>
            <option value="cancelled">cancelled</option>
          </select>

          <div className="border rounded p-3">
            <div className="font-medium mb-2">Cart</div>
            <ul className="space-y-1">
              {Object.entries(cart).map(([pid, qty]) => {
                const p = productById.get(Number(pid))
                if (!p) return null
                return (
                  <li key={pid} className="flex justify-between">
                    <span>{p.name}</span>
                    <span>× {qty}</span>
                  </li>
                )
              })}
              {Object.keys(cart).length === 0 && (
                <li className="text-gray-500 text-sm">No items added</li>
              )}
            </ul>
          </div>

          <Button onClick={createOrder}>Create Order</Button>
        </div>
      </div>
    </section>
  )
})

export const OrderRow = memo(function OrderRow({
  order,
  onSelect,
  onCancel,
}: {
  order: Order
  onSelect: (order: Order) => void
  onCancel: (id: number) => void
}) {
  const contextLabel = `order #${order.id}`
  return (
    <TableRow>
      <TableRowHeader>{order.id}</TableRowHeader>
      <TableCell>{order.status}</TableCell>
      <TableCell>{new Date(order.created_at).toLocaleString()}</TableCell>
      <TableCell className="flex gap-2">
        <Button contextLabel={contextLabel} onClick={() => onSelect(order)}>
          View
        </Button>
        {order.status !== 'cancelled' && order.status !== 'completed' && (
          <Button contextLabel={contextLabel} onClick={() => onCancel(order.id)}>
            Cancel
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
})

export const OrdersTable = memo(function OrdersTable({
  orders,
  onSelect,
  onCancel,
}: {
  orders: Order[]
  onSelect: (order: Order) => void
  onCancel: (id: number) => void
}) {
  return (
    <section>
      <Table caption="Orders" hideCaption>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map(o => (
            <OrderRow key={o.id} order={o} onSelect={onSelect} onCancel={onCancel} />
          ))}
        </TableBody>
      </Table>
    </section>
  )
})

export default function Orders() {
  const user = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order | null>(null)
  const [products, setProducts] = useState<Product[]>([])

  const fetchOrders = useCallback(() => {
    api
      .get('/orders')
      .then(r => setOrders(r.data))
      .catch(() =>
        toast({ title: 'Error', description: 'Failed to load orders', variant: 'destructive' })
      )
  }, [])

  const loadProducts = useCallback(() => {
    api
      .get('/inventory')
      .then(r => setProducts(r.data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (user) {
      fetchOrders()
      loadProducts()
    }
  }, [user, fetchOrders, loadProducts])

  const handleSocket = useCallback(
    (s: any) => {
      s.on('new_order', () => {
        toast({ title: 'New Order' })
        fetchOrders()
      })
      s.on('order_cancelled', () => {
        toast({ title: 'Order cancelled' })
        fetchOrders()
      })
      s.on('stock_update', () => {
        loadProducts()
      })
    },
    [fetchOrders, loadProducts]
  )
  useSocket(handleSocket, Boolean(user))

  const cancelOrder = useCallback(
    async (id: number) => {
      try {
        await api.post(`/orders/${id}/cancel`)
        toast({ title: 'Order cancelled' })
        fetchOrders()
      } catch (e: any) {
        toast({
          title: 'Error',
          description: e?.response?.data?.detail ?? 'Failed to cancel order',
          variant: 'destructive',
        })
      }
    },
    [fetchOrders]
  )

  const handleSelectOrder = useCallback((order: Order) => {
    setSelected(order)
  }, [])

  const handleCloseModal = useCallback(() => {
    setSelected(null)
  }, [])

  if (!user) return null

  return (
    <div className="p-6 space-y-8">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>

      {/* Create New Order */}
      <OrderCreator products={products} onOrderCreated={fetchOrders} />

      {/* Orders table */}
      <OrdersTable orders={orders} onSelect={handleSelectOrder} onCancel={cancelOrder} />

      {selected && <OrderDetailModal order={selected} onClose={handleCloseModal} />}
    </div>
  )
}
