'use client'
import Dialog from './ui/Dialog'
export default function OrderDetailModal({ order, onClose }: any) {
  return (
    <Dialog open={!!order} onOpenChange={onClose}>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Order #{order.id}</h2>
        <div>Status: {order.status}</div>
        <div>Items:</div>
        <ul className="list-disc ml-5">
          {order.items?.map((it:any)=>(
            <li key={it.id}>{it.product?.name ?? 'Item'} × {it.quantity}</li>
          ))}
        </ul>
        <button className="mt-3 px-3 py-2 border rounded" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  )
}
