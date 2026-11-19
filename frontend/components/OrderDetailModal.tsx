'use client'
import { useEffect, useId, useState } from 'react'
import api from '../lib/api'
import { OrderDetail, OrderItemDetail, OrderSummary } from '../lib/orderState'
import Button from './ui/Button'
import Dialog from './ui/Dialog'

type OrderWithOptionalItems = OrderSummary & {
  items?: OrderItemDetail[]
}

type OrderDetailModalProps = {
  order: OrderWithOptionalItems | null | undefined
  initialDetail?: OrderDetail | null
  onClose: () => void
}

export default function OrderDetailModal({
  order,
  initialDetail,
  onClose,
}: OrderDetailModalProps) {
  const titleId = useId()
  const [state, setState] = useState<{
    orderId: number | null
    detail: OrderDetail | null
    error: string | null
  }>({
    orderId: null,
    detail: null,
    error: null,
  })

  const inlineItems = Array.isArray(order?.items)
    ? order!.items
    : initialDetail && order && initialDetail.id === order.id && Array.isArray(initialDetail.items)
      ? initialDetail.items
      : undefined

  useEffect(() => {
    if (!order?.id) {
      setState({ orderId: null, detail: null, error: null })
      return
    }

    if (inlineItems) {
      setState({
        orderId: order.id,
        detail: {
          id: order.id,
          status: order.status,
          created_at: order.created_at,
          items: inlineItems,
        },
        error: null,
      })
      return
    }

    let active = true
    api
      .get(`/orders/${order.id}`)
      .then((res) => {
        if (!active) return
        setState({
          orderId: order.id,
          detail: res.data,
          error: null,
        })
      })
      .catch((err: any) => {
        if (!active) return
        setState({
          orderId: order.id,
          detail: null,
          error: err?.response?.data?.detail ?? 'Failed to load order details',
        })
      })

    return () => {
      active = false
    }
  }, [order?.id, order?.status, order?.created_at, inlineItems])

  if (!order) return null

  const resolvedItems = inlineItems ?? (state.orderId === order.id ? state.detail?.items : undefined)
  const isLoading = !inlineItems && state.orderId !== order.id
  const errorMessage = !inlineItems && state.orderId === order.id ? state.error : null
  const displayStatus =
    order.status === 'cancelled'
      ? 'cancelled'
      : (state.orderId === order.id && state.detail?.status) || order.status

  return (
    <Dialog open={Boolean(order)} onOpenChange={onClose} aria-labelledby={titleId}>
      <div className="space-y-2">
        <h2 id={titleId} className="text-lg font-semibold">Order #{order.id}</h2>
        <div>Status: {displayStatus}</div>
        <div>Items:</div>
        {isLoading && (
          <div role="status" className="text-sm text-gray-600">
            Loading order details...
          </div>
        )}
        {!isLoading && errorMessage && (
          <div role="alert" className="text-sm text-red-800">
            {errorMessage}
          </div>
        )}
        {!isLoading && !errorMessage && (
          <ul className="list-disc ml-5">
            {resolvedItems?.map((it) => (
              <li key={it.id}>{it.product?.name ?? 'Item'} × {it.quantity}</li>
            ))}
          </ul>
        )}
        <Button type="button" className="mt-3" onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  )
}
