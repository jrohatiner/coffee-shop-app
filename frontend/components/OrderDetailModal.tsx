'use client'
import { useId } from 'react'
import Button from './ui/Button'
import Dialog from './ui/Dialog'

type OrderItem = {
  id: number | string
  quantity: number
  product?: {
    name?: string
  }
}

type Order = {
  id: number | string
  status: string
  items?: OrderItem[]
}

type OrderDetailModalProps = {
  order: Order | null | undefined
  onClose: () => void
}

export default function OrderDetailModal({ order, onClose }: OrderDetailModalProps) {
  const titleId = useId()
  if (!order) return null

  return (
    <Dialog open={Boolean(order)} onOpenChange={onClose} aria-labelledby={titleId}>
      <div className="space-y-2">
        <h2 id={titleId} className="text-lg font-semibold">Order #{order.id}</h2>
        <div>Status: {order.status}</div>
        <div>Items:</div>
        <ul className="list-disc ml-5">
          {order.items?.map((it) => (
            <li key={it.id}>{it.product?.name ?? 'Item'} × {it.quantity}</li>
          ))}
        </ul>
        <Button type="button" className="mt-3" onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  )
}
