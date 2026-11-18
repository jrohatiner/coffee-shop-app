'use client'
import { useAuth } from '../hooks/useAuth'
import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Button from '../components/ui/Button'
import { Table } from '../components/ui/Table'
import OrderDetailModal from '../components/OrderDetailModal'
import { useSocket } from '../hooks/useSocket'
import Input from '../components/ui/Input'
import type { Socket } from 'socket.io-client'

type Product = { id:number; name:string; price:number; stock:number }
type Order = { id:number; status:string; created_at:string; items:any[] }

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20
const LOCAL_SOCKET_ECHO_TTL_MS = 1500

export default function Orders(){
  const user = useAuth()
  const username = user?.sub ?? null
  const [orders, setOrders] = useState<Order[]>([])
  const [selected, setSelected] = useState<Order|null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<number, number>>({}) // productId -> qty
  const [status, setStatus] = useState<'pending'|'in_progress'|'completed'|'cancelled'>('pending')

  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<string>('')
  const [hasMore, setHasMore] = useState<boolean>(false)

  const requestSeqRef = useRef(0)
  const pendingLocalCreatesRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const pendingLocalCancelsRef = useRef<Map<number, ReturnType<typeof setTimeout> | null>>(new Map())
  const pendingLocalStockRef = useRef<ReturnType<typeof setTimeout>[]>([])

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
      .then((r) => {
        if (seq !== requestSeqRef.current) return
        const data: Order[] = r.data
        setOrders(data)
        const headerHasMore = r.headers?.['x-has-more']
        const more = headerHasMore !== undefined
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
    () => api.get('/inventory').then((r) => setProducts(r.data)).catch(() => {}),
    []
  )

  const fetchOrdersRef = useRef(fetchOrders)
  fetchOrdersRef.current = fetchOrders
  const loadProductsRef = useRef(loadProducts)
  loadProductsRef.current = loadProducts

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
      pendingLocalCreatesRef.current.forEach((t) => clearTimeout(t))
      pendingLocalCreatesRef.current = []
      pendingLocalCancelsRef.current.forEach((t) => { if (t) clearTimeout(t) })
      pendingLocalCancelsRef.current.clear()
      pendingLocalStockRef.current.forEach((t) => clearTimeout(t))
      pendingLocalStockRef.current = []
    }
  }, [])

  const handleSocketReady = useCallback((s: Socket) => {
    s.on('new_order', () => {
      if (pendingLocalCreatesRef.current.length > 0) {
        const timer = pendingLocalCreatesRef.current.shift()
        if (timer) clearTimeout(timer)
        return
      }
      toast({ title: 'New Order' })
      fetchOrdersRef.current()
    })
    s.on('order_cancelled', (payload?: { order_id?: number }) => {
      const cancelledId = payload?.order_id
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
      fetchOrdersRef.current()
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

  useSocket(handleSocketReady)

  if(!user) return null

  const setQty = (pid:number, qty:number) => {
    setCart(prev => {
      const next = { ...prev }
      if(qty <= 0) delete next[pid]; else next[pid] = qty
      return next
    })
  }

  const createOrder = async () => {
    const items = Object.entries(cart).map(([product_id, quantity])=>({ product_id: Number(product_id), quantity: Number(quantity) }))
    if(items.length === 0){ toast({title:'Add at least one item', variant:'destructive'}); return }

    const createEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
    clearTimeout(createEchoToken)
    pendingLocalCreatesRef.current.push(createEchoToken)

    const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
    clearTimeout(stockEchoToken)
    pendingLocalStockRef.current.push(stockEchoToken)

    try{
      await api.post('/orders', { status, items })
      toast({title:'Order created'})
      setCart({})
      setStatus('pending')

      const createIdx = pendingLocalCreatesRef.current.indexOf(createEchoToken)
      if (createIdx !== -1) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalCreatesRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalCreatesRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        pendingLocalCreatesRef.current[createIdx] = expiry
      }

      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalStockRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        pendingLocalStockRef.current[stockIdx] = expiry
      }

      await Promise.all([fetchOrders(), loadProducts()])
    }catch(e:any){
      const createIdx = pendingLocalCreatesRef.current.indexOf(createEchoToken)
      if (createIdx !== -1) pendingLocalCreatesRef.current.splice(createIdx, 1)
      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to create order', variant:'destructive'})
    }
  }

  const cancelOrder = async (id:number) => {
    pendingLocalCancelsRef.current.set(id, null)
    const stockEchoToken = setTimeout(() => {}, LOCAL_SOCKET_ECHO_TTL_MS)
    clearTimeout(stockEchoToken)
    pendingLocalStockRef.current.push(stockEchoToken)

    try{
      await api.post(`/orders/${id}/cancel`)
      toast({title:'Order cancelled'})

      if (pendingLocalCancelsRef.current.has(id)) {
        const expiry = setTimeout(() => {
          pendingLocalCancelsRef.current.delete(id)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        pendingLocalCancelsRef.current.set(id, expiry)
      }

      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) {
        const expiry = setTimeout(() => {
          const idx = pendingLocalStockRef.current.indexOf(expiry)
          if (idx !== -1) pendingLocalStockRef.current.splice(idx, 1)
        }, LOCAL_SOCKET_ECHO_TTL_MS)
        pendingLocalStockRef.current[stockIdx] = expiry
      }

      await Promise.all([fetchOrders(), loadProducts()])
    }catch(e:any){
      const existing = pendingLocalCancelsRef.current.get(id)
      if (existing) clearTimeout(existing)
      pendingLocalCancelsRef.current.delete(id)
      const stockIdx = pendingLocalStockRef.current.indexOf(stockEchoToken)
      if (stockIdx !== -1) pendingLocalStockRef.current.splice(stockIdx, 1)
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to cancel order', variant:'destructive'})
    }
  }

  return (
    <main className="p-6 space-y-8">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>

      {/* Create New Order */}
      <section className="border rounded p-4 space-y-3 max-w-3xl">
        <h2 className="font-semibold text-lg">Create New Order</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="font-medium">Pick Products</div>
            <div className="space-y-2 max-h-80 overflow-auto pr-2">
              {products.map(p=>(
                <div key={p.id} className="flex items-center justify-between border rounded p-2">
                  <div className="flex flex-col">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm text-gray-600">${p.price.toFixed(2)} · stock {p.stock}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Qty</span>
                    <Input type="number" min={0} value={cart[p.id] ?? 0} onChange={e=>setQty(p.id, parseInt((e.target as HTMLInputElement).value || '0'))} className="w-20"/>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="font-medium">Order Status</div>
            <select className="border rounded px-3 py-2" value={status} onChange={e=>setStatus(e.target.value as any)}>
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
            </select>

            <div className="border rounded p-3">
              <div className="font-medium mb-2">Cart</div>
              <ul className="space-y-1">
                {Object.entries(cart).map(([pid, qty])=>{
                  const p = products.find(pp=>pp.id === Number(pid))
                  if(!p) return null
                  return <li key={pid} className="flex justify-between"><span>{p.name}</span><span>× {qty}</span></li>
                })}
                {Object.keys(cart).length===0 && <li className="text-gray-500 text-sm">No items added</li>}
              </ul>
            </div>

            <Button onClick={createOrder}>Create Order</Button>
          </div>
        </div>
      </section>

      {/* Orders table & pagination */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="orders-status-filter" className="text-sm font-medium">Status Filter</label>
            <select
              id="orders-status-filter"
              aria-label="Filter by status"
              className="border rounded px-3 py-2"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value)
                setPage(1)
              }}
            >
              <option value="">All statuses</option>
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="orders-date-filter" className="text-sm font-medium">Date Filter</label>
            <Input
              id="orders-date-filter"
              aria-label="Filter by date"
              type="date"
              className="w-44"
              value={dateFilter}
              onChange={(e) => {
                setDateFilter((e.target as HTMLInputElement).value)
                setPage(1)
              }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="orders-page-size" className="text-sm font-medium">Page Size</label>
            <select
              id="orders-page-size"
              aria-label="Orders per page"
              className="border rounded px-3 py-2"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setPage(1)
              }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size} per page</option>
              ))}
            </select>
          </div>

          {(statusFilter || dateFilter) && (
            <Button
              onClick={() => {
                setStatusFilter('')
                setDateFilter('')
                setPage(1)
              }}
            >
              Clear Filters
            </Button>
          )}
        </div>

        <Table>
          <thead><tr><th>ID</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {orders.map(o=>(
              <tr key={o.id}>
                <td>{o.id}</td>
                <td>{o.status}</td>
                <td>{new Date(o.created_at).toLocaleString()}</td>
                <td className="flex gap-2">
                  <Button onClick={()=>setSelected(o as any)}>View</Button>
                  {(o.status !== 'cancelled' && o.status !== 'completed') && (
                    <Button onClick={()=>cancelOrder(o.id)}>Cancel</Button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-gray-500">No orders found.</td>
              </tr>
            )}
          </tbody>
        </Table>

        <div className="flex items-center justify-between pt-2">
          <div className="text-sm text-gray-600">
            Page {page} · Showing {orders.length} {orders.length === 1 ? 'order' : 'orders'}
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={page <= 1}
              className="disabled:opacity-50 disabled:pointer-events-none"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              disabled={!hasMore}
              className="disabled:opacity-50 disabled:pointer-events-none"
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </section>

      {selected && <OrderDetailModal order={selected} onClose={()=>setSelected(null)} />}
    </main>
  )
}
