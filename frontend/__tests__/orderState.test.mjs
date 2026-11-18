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

const { toOrderSummary, reconcileCreatedOrder, reconcileCancelledOrder } = moduleObj.exports

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

  // Case A: HTTP resolves first, then socket arrives
  const afterHttp = reconcileCreatedOrder(initial, postResponse)
  const afterSocket = reconcileCreatedOrder(afterHttp, socketPayload)
  assert.equal(afterSocket.length, 2)
  assert.deepEqual(afterSocket.map(o => o.id), [1, 2])

  // Case B: Socket arrives first, then HTTP resolves
  const socketFirst = reconcileCreatedOrder(initial, socketPayload)
  const httpSecond = reconcileCreatedOrder(socketFirst, postResponse)
  assert.equal(httpSecond.length, 2)
  assert.deepEqual(httpSecond.map(o => o.id), [1, 2])
}

// 3. Deduplicates local cancelOrder response and concurrent order_cancelled socket events
{
  const initial = [
    { id: 1, status: 'pending', created_at: '2026-11-18T10:00:00' },
    { id: 2, status: 'pending', created_at: '2026-11-18T10:05:00' },
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
  assert.equal(step2[1].status, 'cancelled')
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

console.log('All frontend orderState reconciliation tests passed!')
