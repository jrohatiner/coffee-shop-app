'use client'
import { useEffect, useId, useState } from 'react'
import api from '../lib/api'
import { OrderDetail, OrderSummary } from '../lib/orderState'
import { getApiErrorDetail } from '../types/api'
import Dialog from './ui/Dialog'
import Button from './ui/Button'

type OrderDetailModalProps = {
  order: OrderSummary | null | undefined
  onClose: () => void
}

export default function OrderDetailModal({
  order,
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

  useEffect(() => {
    if (!order?.id) {
      setState({ orderId: null, detail: null, error: null })
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
      .catch((err: unknown) => {
        if (!active) return
        setState({
          orderId: order.id,
          detail: null,
          error: getApiErrorDetail(err, 'Failed to load order details'),
        })
      })

    return () => {
      active = false
    }
  }, [order?.id])

  if (!order) return null

  const isLoading = state.orderId !== order.id
  const displayStatus =
    order.status === 'cancelled'
      ? 'cancelled'
      : (state.orderId === order.id && state.detail?.status) || order.status

  return (
    <Dialog
      open={Boolean(order)}
      onOpenChange={onClose}
      aria-labelledby={titleId}
    >
      <div className="space-y-2">
        <h2 id={titleId} className="text-lg font-semibold">
          Order #{order.id}
        </h2>
        <div>Status: {displayStatus}</div>
        <div>Items:</div>
        {isLoading && (
          <div role="status" className="text-sm text-gray-600">
            Loading order details...
          </div>
        )}
        {!isLoading && state.error && (
          <div role="alert" className="text-sm text-red-600">
            {state.error}
          </div>
        )}
        {!isLoading && !state.error && (
          <ul className="list-disc ml-5">
            {state.detail?.items?.map((it) => (
              <li key={it.id}>
                {it.product?.name ?? 'Item'} × {it.quantity}
              </li>
            ))}
          </ul>
        )}
        <Button type="button" className="mt-3" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}
