'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useMemo, useState } from 'react'
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
import { OrderSummary, reconcileCancelledOrder, reconcileCreatedOrder } from '../lib/orderState'

type Product = { id:number; name:string; price:number; stock:number }

export default function Orders(){
  const user = useAuth()
  const [orders,setOrders]=useState<OrderSummary[]>([])
  const [selectedId,setSelectedId]=useState<number|null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<number, number>>({}) // productId -> qty
  const [status, setStatus] = useState<'pending'|'in_progress'|'completed'|'cancelled'>('pending')

  const productById = useMemo(
    () => new Map<number, Product>(products.map(p => [p.id, p])),
    [products]
  )
  const orderRows = useMemo(
    () => orders.map(order => ({ order, formattedCreatedAt: formatOrderDate(order.created_at) })),
    [orders]
  )

  const fetchOrders=()=>api.get('/orders').then(r=>setOrders(r.data)).catch(()=>toast({title:'Error', description:'Failed to load orders', variant:'destructive'}))
  const loadProducts=()=>api.get('/inventory').then(r=>setProducts(r.data)).catch(()=>{})

  useEffect(()=>{ if(user){ fetchOrders(); loadProducts() } },[user?.sub])
  useSocket(s=>{
    s.on('new_order', (payload: unknown)=>{
      toast({title:'New Order'})
      setOrders(prev => reconcileCreatedOrder(prev, payload))
    })
    s.on('order_cancelled', (payload: unknown)=>{
      toast({title:'Order cancelled'})
      setOrders(prev => reconcileCancelledOrder(prev, payload))
    })
    s.on('stock_update', ()=>{ loadProducts() })
  }, Boolean(user))

  if(!user) return null

  const selected = selectedId !== null ? (orders.find(o => o.id === selectedId) ?? null) : null

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
    try{
      const res = await api.post('/orders', { status, items })
      setOrders(prev => reconcileCreatedOrder(prev, res.data))
      toast({title:'Order created'})
      setCart({})
      setStatus('pending')
    }catch(e:any){
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to create order', variant:'destructive'})
    }
  }

  const cancelOrder = async (id:number) => {
    try{
      const res = await api.post(`/orders/${id}/cancel`)
      setOrders(prev => reconcileCancelledOrder(prev, res.data))
      toast({title:'Order cancelled'})
    }catch(e:any){
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to cancel order', variant:'destructive'})
    }
  }

  return (
    <div className="p-6 space-y-8">
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
                  const p = productById.get(Number(pid))
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

      {/* Orders table */}
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
            {orderRows.map(({ order: o, formattedCreatedAt })=>(
              <TableRow key={o.id}>
                <TableRowHeader>{o.id}</TableRowHeader>
                <TableCell>{o.status}</TableCell>
                <TableCell>{formattedCreatedAt}</TableCell>
                <TableCell className="flex gap-2">
                  <Button contextLabel={`order #${o.id}`} onClick={()=>setSelectedId(o.id)}>View</Button>
                  {(o.status !== 'cancelled' && o.status !== 'completed') && (
                    <Button contextLabel={`order #${o.id}`} onClick={()=>cancelOrder(o.id)}>Cancel</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {selected && <OrderDetailModal order={selected} onClose={()=>setSelectedId(null)} />}
    </div>
  )
}
