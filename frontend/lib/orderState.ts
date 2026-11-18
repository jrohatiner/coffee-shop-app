export type OrderSummary = {
  id: number
  status: string
  created_at: string
}

export type OrderItemDetail = {
  id: number
  product_id?: number
  quantity: number
  product?: {
    id: number
    name: string
    price?: number
    stock?: number
  }
}

export type OrderDetail = OrderSummary & {
  user_id?: number
  items: OrderItemDetail[]
}

export function toOrderSummary(raw: any): OrderSummary | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'number') {
    return null
  }
  if (typeof raw.created_at !== 'string' || !raw.created_at) {
    return null
  }
  return {
    id: raw.id,
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'pending',
    created_at: raw.created_at,
  }
}

/**
 * Reconciles an order summary from POST /orders or a `new_order` Socket.IO event
 * into the existing summary list without duplicates or regressing a cancelled status.
 */
export function reconcileCreatedOrder(
  orders: OrderSummary[],
  payload: unknown,
): OrderSummary[] {
  const summary = toOrderSummary(payload)
  if (!summary) {
    return orders
  }

  const existingIndex = orders.findIndex((o) => o.id === summary.id)
  if (existingIndex === -1) {
    return [...orders, summary]
  }

  const existing = orders[existingIndex]
  const nextStatus =
    existing.status === 'cancelled' && summary.status !== 'cancelled'
      ? 'cancelled'
      : summary.status

  if (existing.status === nextStatus && existing.created_at === summary.created_at) {
    return orders
  }

  const next = [...orders]
  next[existingIndex] = {
    id: existing.id,
    status: nextStatus,
    created_at: summary.created_at || existing.created_at,
  }
  return next
}

/**
 * Reconciles an order cancellation from POST /orders/{id}/cancel or an
 * `order_cancelled` Socket.IO event without duplicating rows.
 */
export function reconcileCancelledOrder(
  orders: OrderSummary[],
  payload: unknown,
): OrderSummary[] {
  if (!payload || typeof payload !== 'object') {
    return orders
  }

  const record = payload as Record<string, unknown>
  const rawId =
    typeof record.id === 'number'
      ? record.id
      : typeof record.order_id === 'number'
        ? record.order_id
        : null

  if (rawId === null) {
    return orders
  }

  const nextStatus =
    typeof record.status === 'string' && record.status ? record.status : 'cancelled'
  const incomingCreatedAt =
    typeof record.created_at === 'string' && record.created_at ? record.created_at : null

  const existingIndex = orders.findIndex((o) => o.id === rawId)
  if (existingIndex !== -1) {
    const existing = orders[existingIndex]
    const resolvedCreatedAt = incomingCreatedAt ?? existing.created_at
    if (existing.status === nextStatus && existing.created_at === resolvedCreatedAt) {
      return orders
    }
    const next = [...orders]
    next[existingIndex] = {
      id: existing.id,
      status: nextStatus,
      created_at: resolvedCreatedAt,
    }
    return next
  }

  if (incomingCreatedAt) {
    return [
      ...orders,
      {
        id: rawId,
        status: nextStatus,
        created_at: incomingCreatedAt,
      },
    ]
  }

  return orders
}
