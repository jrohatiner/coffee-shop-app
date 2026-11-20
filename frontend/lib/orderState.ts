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

export type ReconcileOptions = {
  page?: number
  pageSize?: number
  statusFilter?: string
  dateFilter?: string
  hasMore?: boolean
}

function compareOrderSummariesDesc(a: OrderSummary, b: OrderSummary): number {
  const timeA = Date.parse(a.created_at)
  const timeB = Date.parse(b.created_at)
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
    return timeB - timeA
  }
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at ? -1 : 1
  }
  return b.id - a.id
}

function insertDescending(
  orders: OrderSummary[],
  summary: OrderSummary,
  pageSize?: number
): OrderSummary[] {
  const insertAt = orders.findIndex(
    (o) => compareOrderSummariesDesc(summary, o) <= 0
  )
  const next =
    insertAt === -1
      ? [...orders, summary]
      : [...orders.slice(0, insertAt), summary, ...orders.slice(insertAt)]
  if (pageSize && next.length > pageSize) {
    return next.slice(0, pageSize)
  }
  return next
}

export function toOrderSummary(raw: unknown): OrderSummary | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'number') {
    return null
  }
  if (typeof record.created_at !== 'string' || !record.created_at) {
    return null
  }
  return {
    id: record.id,
    status:
      typeof record.status === 'string' && record.status
        ? record.status
        : 'pending',
    created_at: record.created_at,
  }
}

/**
 * Reconciles an order summary from POST /orders or a `new_order` Socket.IO event
 * into the existing summary list without duplicates or regressing a cancelled status.
 */
export function reconcileCreatedOrder(
  orders: OrderSummary[],
  payload: unknown,
  options?: ReconcileOptions
): OrderSummary[] {
  const summary = toOrderSummary(payload)
  if (!summary) {
    return orders
  }

  const existingIndex = orders.findIndex((o) => o.id === summary.id)
  if (existingIndex === -1) {
    if ((options?.page ?? 1) > 1) {
      return orders
    }
    if (options?.statusFilter && summary.status !== options.statusFilter) {
      return orders
    }
    if (
      options?.dateFilter &&
      summary.created_at.slice(0, 10) !== options.dateFilter
    ) {
      return orders
    }
    return insertDescending(orders, summary, options?.pageSize)
  }

  const existing = orders[existingIndex]
  const nextStatus =
    existing.status === 'cancelled' && summary.status !== 'cancelled'
      ? 'cancelled'
      : summary.status

  if (
    existing.status === nextStatus &&
    existing.created_at === summary.created_at
  ) {
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
  options?: ReconcileOptions
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
    typeof record.status === 'string' && record.status
      ? record.status
      : 'cancelled'
  const incomingCreatedAt =
    typeof record.created_at === 'string' && record.created_at
      ? record.created_at
      : null

  const existingIndex = orders.findIndex((o) => o.id === rawId)
  if (existingIndex !== -1) {
    if (options?.statusFilter && nextStatus !== options.statusFilter) {
      return [
        ...orders.slice(0, existingIndex),
        ...orders.slice(existingIndex + 1),
      ]
    }
    const existing = orders[existingIndex]
    const resolvedCreatedAt = incomingCreatedAt ?? existing.created_at
    if (
      existing.status === nextStatus &&
      existing.created_at === resolvedCreatedAt
    ) {
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
    if ((options?.page ?? 1) > 1) {
      return orders
    }
    if (options?.statusFilter && nextStatus !== options.statusFilter) {
      return orders
    }
    if (
      options?.dateFilter &&
      incomingCreatedAt.slice(0, 10) !== options.dateFilter
    ) {
      return orders
    }
    const candidate: OrderSummary = {
      id: rawId,
      status: nextStatus,
      created_at: incomingCreatedAt,
    }
    const pageFull =
      Boolean(options?.hasMore) ||
      Boolean(options?.pageSize && orders.length >= options.pageSize)
    if (pageFull && orders.length > 0) {
      const oldestOnPage = orders[orders.length - 1]
      if (compareOrderSummariesDesc(candidate, oldestOnPage) > 0) {
        return orders
      }
    }
    return insertDescending(orders, candidate, options?.pageSize)
  }

  return orders
}

export type ProductItem = {
  id: number
  name: string
  price: number
  stock: number
}

export type StockDelta = {
  updated: ProductItem[]
  deleted_ids: number[]
}

export function toProductItem(raw: unknown): ProductItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'number' || !Number.isFinite(record.id)) {
    return null
  }
  if (typeof record.name !== 'string') {
    return null
  }
  if (typeof record.price !== 'number' || !Number.isFinite(record.price)) {
    return null
  }
  if (typeof record.stock !== 'number' || !Number.isFinite(record.stock)) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    price: record.price,
    stock: record.stock,
  }
}

export function hasDeleteDetail(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false
  }
  const detail = (raw as Record<string, unknown>).detail
  return typeof detail === 'string' && detail.trim().length > 0
}

/**
 * Validates a `stock_update` Socket.IO delta payload (`{ updated, deleted_ids }`).
 * Returns `null` when payload is missing or contains invalid product/id entries so
 * callers can fall back to `GET /inventory`.
 */
export function parseStockDelta(payload: unknown): StockDelta | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  const hasUpdated = 'updated' in record
  const hasDeleted = 'deleted_ids' in record
  if (!hasUpdated && !hasDeleted) {
    return null
  }

  const updated: ProductItem[] = []
  if (hasUpdated) {
    if (!Array.isArray(record.updated)) {
      return null
    }
    for (const entry of record.updated) {
      const parsed = toProductItem(entry)
      if (!parsed) {
        return null
      }
      updated.push(parsed)
    }
  }

  const deleted_ids: number[] = []
  if (hasDeleted) {
    if (!Array.isArray(record.deleted_ids)) {
      return null
    }
    for (const id of record.deleted_ids) {
      if (typeof id !== 'number' || !Number.isFinite(id)) {
        return null
      }
      deleted_ids.push(id)
    }
  }

  return { updated, deleted_ids }
}

/**
 * Extracts deduplicated `ProductOut` items from an `OrderOut` response
 * (`POST /orders` or `POST /orders/{id}/cancel`). Returns `null` when the
 * response lacks authoritative `items[].product` fields so callers fall back
 * to `GET /inventory`.
 */
export function extractOrderStockDelta(payload: unknown): StockDelta | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  if (typeof record.id !== 'number' || !Array.isArray(record.items)) {
    return null
  }

  const byId = new Map<number, ProductItem>()
  for (const rawItem of record.items) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return null
    }
    const itemRecord = rawItem as Record<string, unknown>
    // Partial cancel restock sets `product: null` when a product row was deleted
    if (
      itemRecord.product === null &&
      typeof itemRecord.product_id === 'number'
    ) {
      continue
    }
    const prod = toProductItem(itemRecord.product)
    if (!prod) {
      return null
    }
    byId.set(prod.id, prod)
  }

  return {
    updated: Array.from(byId.values()),
    deleted_ids: [],
  }
}

/**
 * Purely merges `StockDelta` into `products`:
 * - Updates matching products in place when values changed, preserving object
 *   identity for unchanged products (and returning `products` unchanged when
 *   the delta is a no-op).
 * - Appends unseen products from `delta.updated` in arrival order.
 * - Removes any product whose `id` is in `delta.deleted_ids`.
 */
export function reconcileProductsDelta<T extends ProductItem>(
  products: T[],
  delta: StockDelta
): T[] {
  const deletedSet = new Set<number>(delta.deleted_ids)
  const updatedById = new Map<number, ProductItem>()
  for (const item of delta.updated) {
    if (!deletedSet.has(item.id)) {
      updatedById.set(item.id, item)
    }
  }

  if (deletedSet.size === 0 && updatedById.size === 0) {
    return products
  }

  let changed = false
  const seenIds = new Set<number>()
  const next: T[] = []

  for (const existing of products) {
    if (deletedSet.has(existing.id)) {
      changed = true
      continue
    }
    const incoming = updatedById.get(existing.id)
    if (!incoming) {
      next.push(existing)
      continue
    }
    seenIds.add(existing.id)
    if (
      existing.name === incoming.name &&
      existing.price === incoming.price &&
      existing.stock === incoming.stock
    ) {
      next.push(existing)
    } else {
      next.push({
        ...existing,
        id: incoming.id,
        name: incoming.name,
        price: incoming.price,
        stock: incoming.stock,
      })
      changed = true
    }
  }

  for (const incoming of Array.from(updatedById.values())) {
    if (!seenIds.has(incoming.id)) {
      next.push({
        id: incoming.id,
        name: incoming.name,
        price: incoming.price,
        stock: incoming.stock,
      } as T)
      changed = true
    }
  }

  return changed ? next : products
}
