'use client'
import { useAuth } from '../hooks/useAuth'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import FormErrorBanner from '../components/ui/FormErrorBanner'
import type { Socket } from 'socket.io-client'
import {
  extractOrderStockDelta,
  OrderSummary,
  parseStockDelta,
  ProductItem,
  reconcileCancelledOrder,
  reconcileCreatedOrder,
  reconcileProductsDelta,
  StockDelta,
  toOrderSummary,
} from '../lib/orderState'
import {
  getApiErrorDetail,
  OrderItemOut,
  OrderStatus,
  unrefTimer,
} from '../types/api'

export type Product = ProductItem
export type Order = OrderSummary & { items?: OrderItemOut[] }

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20
const LOCAL_SOCKET_ECHO_TTL_MS = 1500

export const ProductPickerRow = memo(function ProductPickerRow({
  product,
  quantity,
  onChangeQty,
}: {
  product: Product
  quantity: number
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
        type="number"
        min={0}
        value={quantity}
        onChange={(e) =>
          onChangeQty(
            product.id,
            parseInt((e.target as HTMLInputElement).value || '0', 10)
          )
        }
        className="w-20"
      />
    </div>
  )
})

export const OrderCreator = memo(function OrderCreator({
  products,
  isProductsLoading = false,
  productsError = null,
  onOrderCreated,
  onSubmitOrder,
}: {
  products: Product[]
  isProductsLoading?: boolean
  productsError?: string | null
  onOrderCreated: () => void | Promise<unknown>
  onSubmitOrder?: (payload: {
    status: OrderStatus
    items: { product_id: number; quantity: number }[]
  }) => Promise<boolean | void>
}) {
  const [cart, setCart] = useState<Record<number, number>>({})
  const [status, setStatus] = useState<OrderStatus>('pending')

  const productById = useMemo(
    () => new Map<number, Product>(products.map((p) => [p.id, p])),
    [products]
  )

  const setQty = useCallback((pid: number, qty: number) => {
    const normalizedQty = Number.isNaN(qty) ? 0 : qty
    setCart((prev) => {
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
      let reconciledInPlace = false
      if (onSubmitOrder) {
        reconciledInPlace = (await onSubmitOrder({ status, items })) === true
      } else {
        await api.post('/orders', { status, items })
      }
      toast({ title: 'Order created' })
      setCart({})
      setStatus('pending')
      if (!reconciledInPlace) {
        await onOrderCreated()
      }
    } catch (e: unknown) {
      toast({
        title: 'Error',
        description: getApiErrorDetail(e, 'Failed to create order'),
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
          {isProductsLoading && (
            <div
              role="status"
              aria-live="polite"
              className="text-sm text-gray-700"
            >
              Loading products...
            </div>
          )}
          {!isProductsLoading && productsError && (
            <FormErrorBanner message={productsError} />
          )}
          {!isProductsLoading && !productsError && products.length === 0 && (
            <div
              role="status"
              aria-live="polite"
              className="text-sm text-gray-700"
            >
              No products available.
            </div>
          )}
          {!productsError && (
            <div className="space-y-2 max-h-80 overflow-auto pr-2">
              {products.map((p) => (
                <ProductPickerRow
                  key={p.id}
                  product={p}
                  quantity={cart[p.id] ?? 0}
                  onChangeQty={setQty}
                />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <Select
            label="Order Status"
            labelClassName="text-base font-medium text-gray-900"
            value={status}
            onChange={(e) => setStatus(e.target.value as OrderStatus)}
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
  order: OrderSummary
  formattedCreatedAt?: string
  onSelect: (order: OrderSummary) => void
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
          <Button
            contextLabel={contextLabel}
            onClick={() => onCancel(order.id)}
          >
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
  orders: OrderSummary[]
  onSelect: (order: OrderSummary) => void
  onCancel: (id: number) => void
}) {
  const orderRows = useMemo(
    () =>
      orders.map((order) => ({
        order,
        formattedCreatedAt: formatOrderDate(order.created_at),
      })),
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
            <TableCell colSpan={4} className="p-4 text-center text-gray-700">
              <div role="status" aria-live="polite">
                No orders found.
              </div>
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
      <Select
        id="orders-status-filter"
        label="Status Filter"
        wrapperClassName="flex flex-col gap-1"
        value={statusFilter}
        onChange={(e) => onStatusFilterChange(e.target.value)}
      >
        <option value="">All statuses</option>
        <option value="pending">pending</option>
        <option value="in_progress">in_progress</option>
        <option value="completed">completed</option>
        <option value="cancelled">cancelled</option>
      </Select>

      <Input
        id="orders-date-filter"
        label="Date Filter"
        wrapperClassName="flex flex-col gap-1"
        type="date"
        className="w-44"
        value={dateFilter}
        onChange={(e) =>
          onDateFilterChange((e.target as HTMLInputElement).value)
        }
      />

      <Select
        id="orders-page-size"
        label="Page Size"
        wrapperClassName="flex flex-col gap-1"
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size} per page
          </option>
        ))}
      </Select>

      {(statusFilter || dateFilter) && (
        <Button onClick={onClearFilters}>Clear Filters</Button>
      )}
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
      <div role="status" aria-live="polite" className="text-sm text-gray-700">
        Page {page} · Showing {ordersCount}{' '}
        {ordersCount === 1 ? 'order' : 'orders'}
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
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [isOrdersLoading, setIsOrdersLoading] = useState<boolean>(true)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [isProductsLoading, setIsProductsLoading] = useState<boolean>(true)
  const [productsError, setProductsError] = useState<string | null>(null)

  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<string>('')
  const [hasMore, setHasMore] = useState<boolean>(false)

  const requestSeqRef = useRef(0)
  const productsSeqRef = useRef(0)
  const pendingLocalCreatesRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const pendingLocalCancelsRef = useRef<
    Map<number, ReturnType<typeof setTimeout> | null>
  >(new Map())
  const pendingLocalStockRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const ordersRef = useRef(orders)
  ordersRef.current = orders
  const viewStateRef = useRef({
    page,
    pageSize,
    statusFilter,
    dateFilter,
    hasMore,
  })
  viewStateRef.current = { page, pageSize, statusFilter, dateFilter, hasMore }

  const applyCreatedOrder = useCallback((payload: unknown) => {
    const view = viewStateRef.current
    const summary = toOrderSummary(payload)
    if (
      summary &&
      view.page === 1 &&
      (!view.statusFilter || summary.status === view.statusFilter) &&
      (!view.dateFilter ||
        summary.created_at.slice(0, 10) === view.dateFilter) &&
      ordersRef.current.length >= view.pageSize &&
      !ordersRef.current.some((o) => o.id === summary.id)
    ) {
      setHasMore(true)
    }
    setOrders((prev) => reconcileCreatedOrder(prev, payload, view))
  }, [])

  const applyCancelledOrder = useCallback((payload: unknown) => {
    const view = viewStateRef.current
    setOrders((prev) => reconcileCancelledOrder(prev, payload, view))
  }, [])

  const applyStockDelta = useCallback((delta: StockDelta) => {
    setProductsError(null)
    setProducts((prev) => reconcileProductsDelta(prev, delta))
  }, [])

  const fetchOrders = useCallback(() => {
    const seq = ++requestSeqRef.current
    setIsOrdersLoading(true)
    setOrdersError(null)
    const params: Record<string, string | number> = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }
    if (statusFilter) params.status = statusFilter
    if (dateFilter) params.date_filter = dateFilter

    return api
      .get('/orders', { params })
      .then((r) => {
        if (seq !== requestSeqRef.current) return
        const data: OrderSummary[] = r.data
        setOrders(data)
        setOrdersError(null)
        const headerHasMore = r.headers?.['x-has-more']
        const more =
          headerHasMore !== undefined
            ? String(headerHasMore).toLowerCase() === 'true'
            : data.length === pageSize
        setHasMore(more)
        setIsOrdersLoading(false)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return
        const fallback = 'Failed to load orders'
        const detail = getApiErrorDetail(err, fallback)
        setOrders([])
        setHasMore(false)
        setOrdersError(detail.trim() || fallback)
        setIsOrdersLoading(false)
        toast({
          title: 'Error',
          description: 'Failed to load orders',
          variant: 'destructive',
        })
      })
  }, [page, pageSize, statusFilter, dateFilter])

  const loadProducts = useCallback(() => {
    const seq = ++productsSeqRef.current
    setIsProductsLoading(true)
    setProductsError(null)
    return api
      .get('/inventory')
      .then((r) => {
        if (seq !== productsSeqRef.current) return
        setProducts(r.data)
        setProductsError(null)
        setIsProductsLoading(false)
      })
      .catch((err: unknown) => {
        if (seq !== productsSeqRef.current) return
        const fallback = 'Failed to load products'
        const detail = getApiErrorDetail(err, fallback)
        setProducts([])
        setProductsError(detail.trim() || fallback)
        setIsProductsLoading(false)
      })
  }, [])

  const loadProductsRef = useRef(loadProducts)
  loadProductsRef.current = loadProducts
  const applyCreatedOrderRef = useRef(applyCreatedOrder)
  applyCreatedOrderRef.current = applyCreatedOrder
  const applyCancelledOrderRef = useRef(applyCancelledOrder)
  applyCancelledOrderRef.current = applyCancelledOrder
  const applyStockDeltaRef = useRef(applyStockDelta)
  applyStockDeltaRef.current = applyStockDelta

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
    const pendingCancels = pendingLocalCancelsRef.current
    return () => {
      pendingLocalCreatesRef.current.forEach((t) => clearTimeout(t))
      pendingLocalCreatesRef.current = []
      pendingCancels.forEach((t) => {
        if (t) clearTimeout(t)
      })
      pendingCancels.clear()
      pendingLocalStockRef.current.forEach((t) => clearTimeout(t))
      pendingLocalStockRef.current = []
    }
  }, [])

  const handleSocketReady = useCallback((s: Socket) => {
    s.on('new_order', (payload: unknown) => {
      applyCreatedOrderRef.current(payload)
      if (pendingLocalCreatesRef.current.length > 0) {
        const timer = pendingLocalCreatesRef.current.shift()
        if (timer) clearTimeout(timer)
        return
      }
      toast({ title: 'New Order' })
    })
    s.on('order_cancelled', (payload: unknown) => {
      applyCancelledOrderRef.current(payload)
      const record =
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : null
      const cancelledId =
        typeof record?.order_id === 'number'
          ? record.order_id
          : typeof record?.id === 'number'
            ? record.id
            : undefined
      if (
        cancelledId != null &&
        pendingLocalCancelsRef.current.has(cancelledId)
      ) {
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
    })
    s.on('stock_update', (payload?: unknown) => {
      const delta = parseStockDelta(payload)
      if (pendingLocalStockRef.current.length > 0) {
        const timer = pendingLocalStockRef.current.shift()
        if (timer) clearTimeout(timer)
        if (delta) {
          applyStockDeltaRef.current(delta)
        }
        return
      }
      if (delta) {
        applyStockDeltaRef.current(delta)
        return
      }
      loadProductsRef.current()
    })
  }, [])

  useSocket(handleSocketReady, Boolean(username))

  const submitOrder = useCallback(
    async ({
      status,
      items,
    }: {
      status: OrderStatus
      items: { product_id: number; quantity: number }[]
    }): Promise<boolean> => {
      const createEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(createEchoToken)
      pendingLocalCreatesRef.current.push(createEchoToken)

      const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
      clearTimeout(stockEchoToken)
      pendingLocalStockRef.current.push(stockEchoToken)

      try {
        const res = await api.post('/orders', { status, items })
        applyCreatedOrderRef.current(res.data)
        const stockDelta = extractOrderStockDelta(res?.data)
        if (stockDelta) {
          applyStockDeltaRef.current(stockDelta)
        }

        const createIdx =
          pendingLocalCreatesRef.current.indexOf(createEchoToken)
        if (createIdx !== -1) {
          const expiry = setTimeout(() => {
            const idx = pendingLocalCreatesRef.current.indexOf(expiry)
            if (idx !== -1) pendingLocalCreatesRef.current.splice(idx, 1)
          }, LOCAL_SOCKET_ECHO_TTL_MS)
          unrefTimer(expiry)
          pendingLocalCreatesRef.current[createIdx] = expiry
        }

        const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
        if (stockIdx !== -1) {
          const expiry = setTimeout(() => {
            const idx = pendingLocalStockRef.current.indexOf(expiry)
            if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
          }, LOCAL_SOCKET_ECHO_TTL_MS)
          unrefTimer(expiry)
          pendingLocalStockRef.current[stockIdx] = expiry
        }

        return stockDelta !== null
      } catch (e) {
        const createIdx =
          pendingLocalCreatesRef.current.indexOf(createEchoToken)
        if (createIdx !== -1)
          pendingLocalCreatesRef.current.splice(createIdx, 1)
        const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
        if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
        throw e
      }
    },
    []
  )

  const handleOrderCreated = useCallback(() => loadProductsRef.current(), [])

  const cancelOrder = useCallback(async (id: number) => {
    pendingLocalCancelsRef.current.set(id, null)
    const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
    clearTimeout(stockEchoToken)
    pendingLocalStockRef.current.push(stockEchoToken)

    try {
      const res = await api.post(`/orders/${id}/cancel`)
      const cancelPayload =
        res?.data &&
        typeof res.data === 'object' &&
        ('id' in res.data || 'order_id' in res.data)
          ? res.data
          : { order_id: id, status: 'cancelled' }
      applyCancelledOrderRef.current(cancelPayload)
      toast({ title: 'Order cancelled' })

      if (pendingLocalCancelsRef.current.has(id)) {
        const expiry = setTimeout(() => {
          pendingLocalCancelsRef.current.delete(id)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        unrefTimer(expiry)
        pendingLocalCancelsRef.current.set(id, expiry)
      }

      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalStockRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        unrefTimer(expiry)
        pendingLocalStockRef.current[stockIdx] = expiry
      }

      const stockDelta = extractOrderStockDelta(res?.data)
      if (stockDelta) {
        applyStockDeltaRef.current(stockDelta)
      } else {
        await loadProductsRef.current()
      }
    } catch (e: unknown) {
      const existing = pendingLocalCancelsRef.current.get(id)
      if (existing) clearTimeout(existing)
      pendingLocalCancelsRef.current.delete(id)
      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
      toast({
        title: 'Error',
        description: getApiErrorDetail(e, 'Failed to cancel order'),
        variant: 'destructive',
      })
    }
  }, [])

  const handleSelectOrder = useCallback((order: OrderSummary) => {
    setSelectedId(order.id)
  }, [])

  const handleCloseModal = useCallback(() => {
    setSelectedId(null)
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
    setPage((p) => Math.max(1, p - 1))
  }, [])

  const handleNextPage = useCallback(() => {
    setPage((p) => p + 1)
  }, [])

  const selected = useMemo(
    () =>
      selectedId !== null
        ? (orders.find((o) => o.id === selectedId) ?? null)
        : null,
    [orders, selectedId]
  )

  if (!user) return null

  return (
    <div className="p-6 space-y-8">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>

      {/* Create New Order */}
      <OrderCreator
        products={products}
        isProductsLoading={isProductsLoading}
        productsError={productsError}
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

        {isOrdersLoading && (
          <div
            role="status"
            aria-live="polite"
            className="text-sm text-gray-700"
          >
            Loading orders...
          </div>
        )}

        {!isOrdersLoading && ordersError && (
          <FormErrorBanner message={ordersError} />
        )}

        {!ordersError && (!isOrdersLoading || orders.length > 0) && (
          <OrdersTable
            orders={orders}
            onSelect={handleSelectOrder}
            onCancel={cancelOrder}
          />
        )}

        <OrdersPagination
          page={page}
          ordersCount={orders.length}
          hasMore={hasMore}
          onPrevPage={handlePrevPage}
          onNextPage={handleNextPage}
        />
      </section>

      {selected && (
        <OrderDetailModal order={selected} onClose={handleCloseModal} />
      )}
    </div>
  )
}
