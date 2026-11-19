'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import api from '../lib/api'
import { formatOrderDate } from '../lib/dateFormat'
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
import Select from '../components/ui/Select'
import type { Socket } from 'socket.io-client'
import {
  OrderDetail,
  OrderItemDetail,
  OrderSummary,
  reconcileCancelledOrder,
  reconcileCreatedOrder,
  toOrderSummary,
} from '../lib/orderState'

export type Product = { id: number; name: string; price: number; stock: number }
export type Order = OrderSummary & { items?: OrderItemDetail[] }
type OrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20
const LOCAL_SOCKET_ECHO_TTL_MS = 1500

export const ProductPickerRow = memo(function ProductPickerRow({
  product,
  quantity,
  hasError = false,
  errorId,
  onChangeQty,
}: {
  product: Product
  quantity: number
  hasError?: boolean
  errorId?: string
  onChangeQty: (pid: number, qty: number) => void
}) {
  const baseId = useId()
  const headingId = `${baseId}-heading`
  const qtyLabelId = `${baseId}-qty-label`
  const qtyInputId = `${baseId}-qty`

  return (
    <div className="flex items-center justify-between border rounded p-2">
      <div className="flex flex-col">
        <span id={headingId} className="font-medium">
          {product.name}
        </span>
        <span className="text-sm text-gray-600">
          ${product.price.toFixed(2)} · stock {product.stock}
        </span>
      </div>
      <Input
        id={qtyInputId}
        label="Qty"
        labelId={qtyLabelId}
        wrapperClassName="flex items-center gap-2"
        labelClassName="inline text-sm font-normal"
        aria-labelledby={`${headingId} ${qtyLabelId}`}
        aria-invalid={hasError ? 'true' : undefined}
        aria-describedby={hasError ? errorId : undefined}
        type="number"
        min={0}
        value={quantity}
        onChange={e =>
          onChangeQty(product.id, parseInt((e.target as HTMLInputElement).value || '0', 10))
        }
        className="w-20"
      />
    </div>
  )
})

export const OrderCreator = memo(function OrderCreator({
  products,
  onOrderCreated,
  onSubmitOrder,
}: {
  products: Product[]
  onOrderCreated: () => void | Promise<unknown>
  onSubmitOrder?: (payload: {
    status: OrderStatus
    items: { product_id: number; quantity: number }[]
  }) => Promise<void>
}) {
  const [cart, setCart] = useState<Record<number, number>>({})
  const [status, setStatus] = useState<OrderStatus>('pending')
  const [orderError, setOrderError] = useState('')

  const productById = useMemo(
    () => new Map<number, Product>(products.map(p => [p.id, p])),
    [products]
  )

  const setQty = useCallback((pid: number, qty: number) => {
    const normalizedQty = Number.isNaN(qty) ? 0 : qty
    if (normalizedQty > 0) {
      setOrderError(prev => (prev ? '' : prev))
    }
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
      setOrderError(
        'Add at least one item with a quantity greater than 0 before submitting an order.'
      )
      toast({ title: 'Add at least one item', variant: 'destructive' })
      return
    }
    try {
      if (onSubmitOrder) {
        await onSubmitOrder({ status, items })
      } else {
        await api.post('/orders', { status, items })
      }
      setOrderError(prev => (prev ? '' : prev))
      toast({ title: 'Order created' })
      setCart({})
      setStatus('pending')
      await onOrderCreated()
    } catch (e: any) {
      const detail = e?.response?.data?.detail ?? 'Failed to create order'
      setOrderError(typeof detail === 'string' ? detail : 'Failed to create order')
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
                hasError={Boolean(orderError)}
                errorId="order-cart-error"
                onChangeQty={setQty}
              />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <Select
            label="Order Status"
            labelClassName="text-base font-medium text-gray-900"
            value={status}
            onChange={e => setStatus(e.target.value as OrderStatus)}
          >
            <option value="pending">pending</option>
            <option value="in_progress">in_progress</option>
            <option value="completed">completed</option>
            <option value="cancelled">cancelled</option>
          </Select>

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
                <li className="text-gray-600 text-sm">No items added</li>
              )}
            </ul>
          </div>

          {orderError && (
            <p
              id="order-cart-error"
              className="flex items-start gap-1.5 text-sm font-medium text-red-800"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="mt-0.5 h-4 w-4 shrink-0 text-red-800"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{orderError}</span>
            </p>
          )}

          <Button onClick={createOrder}>Create Order</Button>
        </div>
      </div>
    </section>
  )
})

export const OrderRow = memo(function OrderRow({
  order,
  formattedCreatedAt,
  onSelect,
  onCancel,
}: {
  order: Order
  formattedCreatedAt?: string
  onSelect: (order: Order) => void
  onCancel: (id: number) => void
}) {
  const contextLabel = `order #${order.id}`
  const displayDate = formattedCreatedAt ?? formatOrderDate(order.created_at)
  return (
    <TableRow>
      <TableRowHeader>{order.id}</TableRowHeader>
      <TableCell>{order.status}</TableCell>
      <TableCell>{displayDate}</TableCell>
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
  const orderRows = useMemo(
    () => orders.map(order => ({ order, formattedCreatedAt: formatOrderDate(order.created_at) })),
    [orders]
  )

  return (
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
        {orderRows.map(({ order: o, formattedCreatedAt }) => (
          <OrderRow
            key={o.id}
            order={o}
            formattedCreatedAt={formattedCreatedAt}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        ))}
        {orders.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="p-4 text-center text-gray-600">
              No orders found.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
})

const OrdersFilters = memo(function OrdersFilters({
  statusFilter,
  dateFilter,
  pageSize,
  onStatusFilterChange,
  onDateFilterChange,
  onPageSizeChange,
  onClearFilters,
}: {
  statusFilter: string
  dateFilter: string
  pageSize: number
  onStatusFilterChange: (value: string) => void
  onDateFilterChange: (value: string) => void
  onPageSizeChange: (size: number) => void
  onClearFilters: () => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="orders-status-filter" className="text-sm font-medium text-gray-800">
          Status Filter
        </label>
        <select
          id="orders-status-filter"
          className="border border-control rounded px-3 py-2 bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          value={statusFilter}
          onChange={e => onStatusFilterChange(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="pending">pending</option>
          <option value="in_progress">in_progress</option>
          <option value="completed">completed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>

      <Input
        id="orders-date-filter"
        label="Date Filter"
        wrapperClassName="flex flex-col gap-1"
        type="date"
        className="w-44"
        value={dateFilter}
        onChange={e => onDateFilterChange((e.target as HTMLInputElement).value)}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="orders-page-size" className="text-sm font-medium text-gray-800">
          Page Size
        </label>
        <select
          id="orders-page-size"
          className="border border-control rounded px-3 py-2 bg-white text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          value={pageSize}
          onChange={e => onPageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map(size => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>
      </div>

      {(statusFilter || dateFilter) && <Button onClick={onClearFilters}>Clear Filters</Button>}
    </div>
  )
})

const OrdersPagination = memo(function OrdersPagination({
  page,
  ordersCount,
  hasMore,
  onPrevPage,
  onNextPage,
}: {
  page: number
  ordersCount: number
  hasMore: boolean
  onPrevPage: () => void
  onNextPage: () => void
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <div className="text-sm text-gray-600">
        Page {page} · Showing {ordersCount} {ordersCount === 1 ? 'order' : 'orders'}
      </div>
      <div className="flex items-center gap-2">
        <Button
          disabled={page <= 1}
          className="disabled:opacity-50 disabled:pointer-events-none"
          onClick={onPrevPage}
        >
          Previous
        </Button>
        <Button
          disabled={!hasMore}
          className="disabled:opacity-50 disabled:pointer-events-none"
          onClick={onNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  )
})

export default function Orders() {
  const user = useAuth()
  const username = user?.sub ?? null
  const [orders, setOrders] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order | null>(null)
  const [products, setProducts] = useState<Product[]>([])

  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<string>('')
  const [hasMore, setHasMore] = useState<boolean>(false)

  const requestSeqRef = useRef(0)
  const pendingLocalCreatesRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const pendingLocalCancelsRef = useRef<Map<number, ReturnType<typeof setTimeout> | null>>(
    new Map()
  )
  const pendingLocalStockRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const orderDetailsByIdRef = useRef<Map<number, OrderDetail>>(new Map())

  const ordersRef = useRef(orders)
  ordersRef.current = orders
  const viewStateRef = useRef({ page, pageSize, statusFilter, dateFilter, hasMore })
  viewStateRef.current = { page, pageSize, statusFilter, dateFilter, hasMore }

  const applyCreatedOrder = useCallback((payload: unknown): boolean => {
    const view = viewStateRef.current
    if (
      payload &&
      typeof payload === 'object' &&
      typeof (payload as OrderDetail).id === 'number' &&
      Array.isArray((payload as OrderDetail).items)
    ) {
      const detail = payload as OrderDetail
      orderDetailsByIdRef.current.set(detail.id, detail)
    }
    const summary = toOrderSummary(payload)
    if (!summary) {
      return false
    }
    if (
      view.page === 1 &&
      (!view.statusFilter || summary.status === view.statusFilter) &&
      (!view.dateFilter || summary.created_at.slice(0, 10) === view.dateFilter) &&
      ordersRef.current.length >= view.pageSize &&
      !ordersRef.current.some(o => o.id === summary.id)
    ) {
      setHasMore(true)
    }
    setOrders(prev => reconcileCreatedOrder(prev, payload, view))
    return true
  }, [])

  const applyCancelledOrder = useCallback((payload: unknown) => {
    const view = viewStateRef.current
    setOrders(prev => reconcileCancelledOrder(prev, payload, view))
    setSelected(prev => {
      if (!prev || !payload || typeof payload !== 'object') return prev
      const rec = payload as Record<string, unknown>
      const id =
        typeof rec.id === 'number'
          ? rec.id
          : typeof rec.order_id === 'number'
            ? rec.order_id
            : null
      if (id === prev.id && prev.status !== 'cancelled') {
        return { ...prev, status: 'cancelled' }
      }
      return prev
    })
  }, [])

  const fetchOrders = useCallback(() => {
    const seq = ++requestSeqRef.current
    const params: Record<string, string | number> = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }
    if (statusFilter) params.status = statusFilter
    if (dateFilter) params.date_filter = dateFilter

    return api
      .get('/orders', { params })
      .then(r => {
        if (seq !== requestSeqRef.current) return
        const data: Order[] = r.data
        setOrders(data)
        const headerHasMore = r.headers?.['x-has-more']
        const more =
          headerHasMore !== undefined
            ? String(headerHasMore).toLowerCase() === 'true'
            : data.length === pageSize
        setHasMore(more)
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return
        toast({ title: 'Error', description: 'Failed to load orders', variant: 'destructive' })
      })
  }, [page, pageSize, statusFilter, dateFilter])

  const loadProducts = useCallback(
    () =>
      api
        .get('/inventory')
        .then(r => setProducts(r.data))
        .catch(() => {}),
    []
  )

  const fetchOrdersRef = useRef(fetchOrders)
  fetchOrdersRef.current = fetchOrders
  const loadProductsRef = useRef(loadProducts)
  loadProductsRef.current = loadProducts
  const applyCreatedOrderRef = useRef(applyCreatedOrder)
  applyCreatedOrderRef.current = applyCreatedOrder
  const applyCancelledOrderRef = useRef(applyCancelledOrder)
  applyCancelledOrderRef.current = applyCancelledOrder

  useEffect(() => {
    if (username) {
      fetchOrders()
    }
  }, [username, fetchOrders])

  useEffect(() => {
    if (username) {
      loadProducts()
    }
  }, [username, loadProducts])

  useEffect(() => {
    return () => {
      pendingLocalCreatesRef.current.forEach(t => clearTimeout(t))
      pendingLocalCreatesRef.current = []
      pendingLocalCancelsRef.current.forEach(t => {
        if (t) clearTimeout(t)
      })
      pendingLocalCancelsRef.current.clear()
      pendingLocalStockRef.current.forEach(t => clearTimeout(t))
      pendingLocalStockRef.current = []
    }
  }, [])

  const handleSocketReady = useCallback((s: Socket) => {
    s.on('new_order', (payload?: unknown) => {
      const reconciled = applyCreatedOrderRef.current(payload)
      if (pendingLocalCreatesRef.current.length > 0) {
        const timer = pendingLocalCreatesRef.current.shift()
        if (timer) clearTimeout(timer)
        return
      }
      toast({ title: 'New Order' })
      if (!reconciled) {
        fetchOrdersRef.current()
      }
    })
    s.on('order_cancelled', (payload?: unknown) => {
      applyCancelledOrderRef.current(payload)
      const record =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
      const cancelledId =
        typeof record?.order_id === 'number'
          ? record.order_id
          : typeof record?.id === 'number'
            ? record.id
            : undefined
      if (cancelledId != null && pendingLocalCancelsRef.current.has(cancelledId)) {
        const timer = pendingLocalCancelsRef.current.get(cancelledId)
        if (timer) clearTimeout(timer)
        pendingLocalCancelsRef.current.delete(cancelledId)
        return
      }
      if (cancelledId == null && pendingLocalCancelsRef.current.size > 0) {
        const firstEntry = pendingLocalCancelsRef.current.entries().next().value
        if (firstEntry) {
          const [id, timer] = firstEntry
          if (timer) clearTimeout(timer)
          pendingLocalCancelsRef.current.delete(id)
          return
        }
      }
      toast({ title: 'Order cancelled' })
      if (cancelledId == null) {
        fetchOrdersRef.current()
      }
    })
    s.on('stock_update', () => {
      if (pendingLocalStockRef.current.length > 0) {
        const timer = pendingLocalStockRef.current.shift()
        if (timer) clearTimeout(timer)
        return
      }
      loadProductsRef.current()
    })
  }, [])

  useSocket(handleSocketReady, Boolean(username))

  const lastSubmitReconciledRef = useRef(false)

  const submitOrder = useCallback(
    async ({
      status,
      items,
    }: {
      status: OrderStatus
      items: { product_id: number; quantity: number }[]
    }) => {
      const createEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(createEchoToken)
      pendingLocalCreatesRef.current.push(createEchoToken)

      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.post('/orders', { status, items })
        lastSubmitReconciledRef.current = applyCreatedOrderRef.current(res?.data)

        const createIdx = pendingLocalCreatesRef.current.indexOf(createEchoToken)
        if (createIdx !== -1) {
          const expiry = setTimeout(() => {
            const idx = pendingLocalCreatesRef.current.indexOf(expiry)
            if (idx !== -1) pendingLocalCreatesRef.current.splice(idx, 1)
          }, LOCAL_SOCKET_ECHO_TTL_MS)
          ;(expiry as any)?.unref?.()
          pendingLocalCreatesRef.current[createIdx] = expiry
        }

        const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
        if (stockIdx !== -1) {
          const expiry = setTimeout(() => {
            const idx = pendingLocalStockRef.current.indexOf(expiry)
            if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
          }, LOCAL_SOCKET_ECHO_TTL_MS)
          ;(expiry as any)?.unref?.()
          pendingLocalStockRef.current[stockIdx] = expiry
        }
      } catch (e) {
        const createIdx = pendingLocalCreatesRef.current.indexOf(createEchoToken)
        if (createIdx !== -1) pendingLocalCreatesRef.current.splice(createIdx, 1)
        const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
        if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
        throw e
      }
    },
    []
  )

  const handleOrderCreated = useCallback(() => {
    if (lastSubmitReconciledRef.current) {
      lastSubmitReconciledRef.current = false
      return loadProductsRef.current()
    }
    return Promise.all([fetchOrdersRef.current(), loadProductsRef.current()])
  }, [])

  const cancelOrder = useCallback(async (id: number) => {
    pendingLocalCancelsRef.current.set(id, null)
    const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
    clearTimeout(stockEchoToken)
    pendingLocalStockRef.current.push(stockEchoToken)

    try {
      const res = await api.post(`/orders/${id}/cancel`)
      applyCancelledOrderRef.current(
        res?.data && typeof res.data === 'object'
          ? { order_id: id, ...res.data }
          : { order_id: id }
      )
      toast({ title: 'Order cancelled' })

      if (pendingLocalCancelsRef.current.has(id)) {
        const expiry = setTimeout(() => {
          pendingLocalCancelsRef.current.delete(id)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        ;(expiry as any)?.unref?.()
        pendingLocalCancelsRef.current.set(id, expiry)
      }

      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalStockRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        ;(expiry as any)?.unref?.()
        pendingLocalStockRef.current[stockIdx] = expiry
      }

      await loadProductsRef.current()
    } catch (e: any) {
      const existing = pendingLocalCancelsRef.current.get(id)
      if (existing) clearTimeout(existing)
      pendingLocalCancelsRef.current.delete(id)
      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
      toast({
        title: 'Error',
        description: e?.response?.data?.detail ?? 'Failed to cancel order',
        variant: 'destructive',
      })
    }
  }, [])

  const handleSelectOrder = useCallback((order: Order) => {
    setSelected(order)
  }, [])

  const handleCloseModal = useCallback(() => {
    setSelected(null)
  }, [])

  const handleStatusFilterChange = useCallback((value: string) => {
    setStatusFilter(value)
    setPage(1)
  }, [])

  const handleDateFilterChange = useCallback((value: string) => {
    setDateFilter(value)
    setPage(1)
  }, [])

  const handlePageSizeChange = useCallback((size: number) => {
    setPageSize(size)
    setPage(1)
  }, [])

  const handleClearFilters = useCallback(() => {
    setStatusFilter('')
    setDateFilter('')
    setPage(1)
  }, [])

  const handlePrevPage = useCallback(() => {
    setPage(p => Math.max(1, p - 1))
  }, [])

  const handleNextPage = useCallback(() => {
    setPage(p => p + 1)
  }, [])

  if (!user) return null

  return (
    <div className="p-6 space-y-8">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>

      {/* Create New Order */}
      <OrderCreator
        products={products}
        onOrderCreated={handleOrderCreated}
        onSubmitOrder={submitOrder}
      />

      {/* Orders table & pagination */}
      <section className="space-y-4">
        <OrdersFilters
          statusFilter={statusFilter}
          dateFilter={dateFilter}
          pageSize={pageSize}
          onStatusFilterChange={handleStatusFilterChange}
          onDateFilterChange={handleDateFilterChange}
          onPageSizeChange={handlePageSizeChange}
          onClearFilters={handleClearFilters}
        />

        <OrdersTable orders={orders} onSelect={handleSelectOrder} onCancel={cancelOrder} />

        <OrdersPagination
          page={page}
          ordersCount={orders.length}
          hasMore={hasMore}
          onPrevPage={handlePrevPage}
          onNextPage={handleNextPage}
        />
      </section>

      {selected && (
        <OrderDetailModal
          order={selected}
          initialDetail={orderDetailsByIdRef.current.get(selected.id)}
          onClose={handleCloseModal}
        />
      )}
    </div>
  )
}
