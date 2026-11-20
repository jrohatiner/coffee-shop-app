import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import vm from 'node:vm'

const sourcePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../lib/orderState.ts',
)
const tsSource = fs.readFileSync(sourcePath, 'utf8')
const transpiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
})

const exportsObj = {}
const moduleObj = { exports: exportsObj }
vm.runInThisContext(
  `(function(exports, module) { ${transpiled.outputText} })`,
)(exportsObj, moduleObj)

const {
  toOrderSummary,
  reconcileCreatedOrder,
  reconcileCancelledOrder,
  toProductItem,
  hasDeleteDetail,
  parseStockDelta,
  extractOrderStockDelta,
  reconcileProductsDelta,
} = moduleObj.exports

// 1. Strips nested items and user_id from full OrderOut response
{
  const fullOrder = {
    id: 10,
    user_id: 1,
    status: 'pending',
    created_at: '2026-11-18T12:00:00',
    items: [{ id: 1, product_id: 2, quantity: 3, product: { id: 2, name: 'Latte', price: 4.5, stock: 77 } }],
  }
  const summary = toOrderSummary(fullOrder)
  assert.deepEqual(summary, {
    id: 10,
    status: 'pending',
    created_at: '2026-11-18T12:00:00',
  })
}

// 2. Deduplicates local POST /orders response and concurrent new_order socket event
{
  const initial = [
    { id: 1, status: 'pending', created_at: '2026-11-18T10:00:00' },
  ]
  const postResponse = {
    id: 2,
    user_id: 1,
    status: 'pending',
    created_at: '2026-11-18T10:05:00',
    items: [{ id: 5, quantity: 1 }],
  }
  const socketPayload = {
    id: 2,
    status: 'pending',
    created_at: '2026-11-18T10:05:00',
  }

  // Case A: HTTP resolves first, then socket arrives (newest-first order)
  const afterHttp = reconcileCreatedOrder(initial, postResponse)
  const afterSocket = reconcileCreatedOrder(afterHttp, socketPayload)
  assert.equal(afterSocket.length, 2)
  assert.deepEqual(afterSocket.map(o => o.id), [2, 1])

  // Case B: Socket arrives first, then HTTP resolves (newest-first order)
  const socketFirst = reconcileCreatedOrder(initial, socketPayload)
  const httpSecond = reconcileCreatedOrder(socketFirst, postResponse)
  assert.equal(httpSecond.length, 2)
  assert.deepEqual(httpSecond.map(o => o.id), [2, 1])
}

// 3. Deduplicates local cancelOrder response and concurrent order_cancelled socket events
{
  const initial = [
    { id: 2, status: 'pending', created_at: '2026-11-18T10:05:00' },
    { id: 1, status: 'pending', created_at: '2026-11-18T10:00:00' },
  ]
  const cancelHttp = {
    id: 2,
    user_id: 1,
    status: 'cancelled',
    created_at: '2026-11-18T10:05:00',
    items: [],
  }
  const cancelSocket = {
    id: 2,
    order_id: 2,
    status: 'cancelled',
    created_at: '2026-11-18T10:05:00',
  }

  const step1 = reconcileCancelledOrder(initial, cancelHttp)
  const step2 = reconcileCancelledOrder(step1, cancelSocket)
  assert.equal(step2.length, 2)
  assert.equal(step2[0].status, 'cancelled')
}

// 4. Out-of-order events: order_cancelled arrives BEFORE delayed new_order
{
  const initial = []
  const cancelFirst = reconcileCancelledOrder(initial, {
    id: 7,
    order_id: 7,
    status: 'cancelled',
    created_at: '2026-11-18T11:00:00',
  })
  const delayedNewOrder = reconcileCreatedOrder(cancelFirst, {
    id: 7,
    status: 'pending',
    created_at: '2026-11-18T11:00:00',
  })
  assert.equal(delayedNewOrder.length, 1)
  assert.equal(delayedNewOrder[0].id, 7)
  assert.equal(delayedNewOrder[0].status, 'cancelled')
}

// 5. Legacy { order_id } cancel payload still updates existing row
{
  const initial = [
    { id: 5, status: 'pending', created_at: '2026-11-18T09:00:00' },
  ]
  const updated = reconcileCancelledOrder(initial, { order_id: 5 })
  assert.equal(updated.length, 1)
  assert.equal(updated[0].status, 'cancelled')
}

// 6. Pagination & filter options: bounds page size, ignores non-page-1 inserts and older unseen cancellations
{
  const page1 = [
    { id: 20, status: 'pending', created_at: '2026-11-18T10:20:00' },
    { id: 19, status: 'pending', created_at: '2026-11-18T10:19:00' },
  ]
  const withNew = reconcileCreatedOrder(
    page1,
    { id: 21, status: 'pending', created_at: '2026-11-18T10:21:00' },
    { page: 1, pageSize: 2, hasMore: true },
  )
  assert.deepEqual(withNew.map(o => o.id), [21, 20])

  const onPage2 = reconcileCreatedOrder(
    page1,
    { id: 22, status: 'pending', created_at: '2026-11-18T10:22:00' },
    { page: 2, pageSize: 2, hasMore: true },
  )
  assert.equal(onPage2, page1)

  const olderCancel = reconcileCancelledOrder(
    page1,
    { id: 5, order_id: 5, status: 'cancelled', created_at: '2026-11-18T08:05:00' },
    { page: 1, pageSize: 2, hasMore: true },
  )
  assert.equal(olderCancel, page1)

  // Removes existing order when active statusFilter excludes cancelled status
  const filteredAfterCancel = reconcileCancelledOrder(
    page1,
    { id: 20, status: 'cancelled' },
    { page: 1, pageSize: 2, statusFilter: 'pending' },
  )
  assert.deepEqual(filteredAfterCancel.map(o => o.id), [19])

  // Keeps existing cancelled order when statusFilter is 'cancelled'
  const cancelledFilterMatch = reconcileCancelledOrder(
    page1,
    { id: 20, status: 'cancelled' },
    { page: 1, pageSize: 2, statusFilter: 'cancelled' },
  )
  assert.deepEqual(cancelledFilterMatch.map(o => ({ id: o.id, status: o.status })), [
    { id: 20, status: 'cancelled' },
    { id: 19, status: 'pending' },
  ])
}

// 7. Product delta merge preserves unchanged object references, appends new products, and deletes removed IDs
{
  const p1 = { id: 1, name: 'Espresso', price: 3.0, stock: 10 }
  const p2 = { id: 2, name: 'Latte', price: 4.5, stock: 20 }
  const p3 = { id: 3, name: 'Cold Brew', price: 5.0, stock: 8 }
  const initial = [p1, p2, p3]

  const next = reconcileProductsDelta(initial, {
    updated: [
      { id: 1, name: 'Espresso', price: 3.0, stock: 6 },
      { id: 4, name: 'Flat White', price: 4.75, stock: 15 },
    ],
    deleted_ids: [3],
  })

  assert.equal(next.length, 3)
  assert.deepEqual(next[0], { id: 1, name: 'Espresso', price: 3.0, stock: 6 })
  assert.notEqual(next[0], p1)
  // Unchanged product keeps exact object identity so React.memo rows skip re-renders
  assert.equal(next[1], p2)
  assert.deepEqual(next[2], { id: 4, name: 'Flat White', price: 4.75, stock: 15 })

  // Applying the same delta again is a strict reference no-op
  const idempotent = reconcileProductsDelta(next, {
    updated: [{ id: 1, name: 'Espresso', price: 3.0, stock: 6 }],
    deleted_ids: [999],
  })
  assert.equal(idempotent, next)
}

// 8. Validation helpers distinguish authoritative payloads from legacy/mocked payloads
{
  assert.deepEqual(toProductItem({ id: 1, name: 'Mocha', price: 4.8, stock: 12 }), {
    id: 1,
    name: 'Mocha',
    price: 4.8,
    stock: 12,
  })
  assert.equal(toProductItem({ id: 1 }), null)
  assert.equal(toProductItem(null), null)

  assert.equal(hasDeleteDetail({ detail: 'Product deleted' }), true)
  assert.equal(hasDeleteDetail({}), false)

  assert.equal(parseStockDelta(undefined), null)
  assert.equal(parseStockDelta({}), null)
  assert.equal(parseStockDelta({ updated: [{ id: 1 }], deleted_ids: [] }), null)
  assert.deepEqual(
    parseStockDelta({
      updated: [{ id: 2, name: 'Latte', price: 4.5, stock: 19 }],
      deleted_ids: [9],
    }),
    {
      updated: [{ id: 2, name: 'Latte', price: 4.5, stock: 19 }],
      deleted_ids: [9],
    },
  )

  // Deduplicates split items and ignores null product on partial cancel restock
  const orderDelta = extractOrderStockDelta({
    id: 42,
    status: 'cancelled',
    items: [
      { id: 1, product_id: 2, quantity: 1, product: { id: 2, name: 'Latte', price: 4.5, stock: 25 } },
      { id: 2, product_id: 2, quantity: 2, product: { id: 2, name: 'Latte', price: 4.5, stock: 25 } },
      { id: 3, product_id: 7, quantity: 1, product: null },
    ],
  })
  assert.deepEqual(orderDelta, {
    updated: [{ id: 2, name: 'Latte', price: 4.5, stock: 25 }],
    deleted_ids: [],
  })

  // Incomplete mocked OrderOut falls back cleanly
  assert.equal(extractOrderStockDelta({ id: 104 }), null)
  assert.equal(
    extractOrderStockDelta({
      id: 104,
      items: [{ id: 1, quantity: 2, product: { name: 'Espresso' } }],
    }),
    null,
  )
}

console.log('All frontend orderState reconciliation tests passed!')
