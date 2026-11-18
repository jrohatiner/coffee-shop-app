'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useId, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Button from '../components/ui/Button'
import { Table } from '../components/ui/Table'
import OrderDetailModal from '../components/OrderDetailModal'
import { useSocket } from '../hooks/useSocket'
import Input from '../components/ui/Input'
import Select from '../components/ui/Select'

type Product = { id:number; name:string; price:number; stock:number }
type Order = { id:number; status:string; created_at:string; items:any[] }

function ProductOrderRow({
  product,
  qty,
  onQtyChange,
}: {
  product: Product
  qty: number
  onQtyChange: (qty: number) => void
}) {
  const baseId = useId()
  const headingId = `${baseId}-heading`
  const qtyLabelId = `${baseId}-qty-label`
  const qtyInputId = `${baseId}-qty`

  return (
    <div className="flex items-center justify-between border rounded p-2">
      <div className="flex flex-col">
        <span id={headingId} className="font-medium">{product.name}</span>
        <span className="text-sm text-gray-600">${product.price.toFixed(2)} · stock {product.stock}</span>
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
        value={qty}
        onChange={e => onQtyChange(parseInt((e.target as HTMLInputElement).value || '0', 10))}
        className="w-20"
      />
    </div>
  )
}

export default function Orders(){
  const user = useAuth()
  const [orders,setOrders]=useState<Order[]>([])
  const [selected,setSelected]=useState<Order|null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<number, number>>({}) // productId -> qty
  const [status, setStatus] = useState<'pending'|'in_progress'|'completed'|'cancelled'>('pending')

  const fetchOrders=()=>api.get('/orders').then(r=>setOrders(r.data)).catch(()=>toast({title:'Error', description:'Failed to load orders', variant:'destructive'}))
  const loadProducts=()=>api.get('/inventory').then(r=>setProducts(r.data)).catch(()=>{})

  useEffect(()=>{ if(user){ fetchOrders(); loadProducts() } },[user])
  useSocket(s=>{
    s.on('new_order', ()=>{ toast({title:'New Order'}); fetchOrders() })
    s.on('order_cancelled', ()=>{ toast({title:'Order cancelled'}); fetchOrders() })
    s.on('stock_update', ()=>{ loadProducts() })
  })

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
    try{
      await api.post('/orders', { status, items })
      toast({title:'Order created'})
      setCart({})
      setStatus('pending')
      fetchOrders()
    }catch(e:any){
      toast({title:'Error', description: e?.response?.data?.detail ?? 'Failed to create order', variant:'destructive'})
    }
  }

  const cancelOrder = async (id:number) => {
    try{
      await api.post(`/orders/${id}/cancel`)
      toast({title:'Order cancelled'})
      fetchOrders()
    }catch(e:any){
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
                <ProductOrderRow
                  key={p.id}
                  product={p}
                  qty={cart[p.id] ?? 0}
                  onQtyChange={qty => setQty(p.id, qty)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Select
              label="Order Status"
              labelClassName="text-base font-medium text-gray-900"
              value={status}
              onChange={e=>setStatus(e.target.value as any)}
            >
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
            </Select>

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

      {/* Orders table */}
      <section>
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
          </tbody>
        </Table>
      </section>

      {selected && <OrderDetailModal order={selected} onClose={()=>setSelected(null)} />}
    </main>
  )
}
