import { expect, Page, test } from '@playwright/test'

type MockOrder = {
  id: number
  status: string
  created_at: string
  items: { id: number; quantity: number; product: { name: string } }[]
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Expose-Headers': 'x-has-more',
}

function createMockJwt(sub = 'manager@coffeeshop.example'): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url')
  return `${header}.${payload}.mock-signature`
}

async function installAuthAndBlockWs(page: Page) {
  const token = createMockJwt()
  await page.addInitScript((jwt) => {
    window.localStorage.setItem('token', jwt)
  }, token)
  await page.route('**/ws/**', async (route) => {
    await route.abort()
  })
}

async function assertActiveElementNotBody(page: Page) {
  const tagName = await page.evaluate(
    () => document.activeElement?.tagName ?? 'NONE'
  )
  expect(tagName).not.toBe('BODY')
  expect(tagName).not.toBe('HTML')
  expect(tagName).not.toBe('NONE')
}

test.describe('Keyboard focus handoff across Orders, Users, and Inventory', () => {
  test('Orders: Cancel, Clear Filters, and Pagination boundaries preserve keyboard focus without resetting to body', async ({
    page,
  }) => {
    await installAuthAndBlockWs(page)

    let allOrders: MockOrder[] = [
      {
        id: 201,
        status: 'pending',
        created_at: '2026-11-18T11:00:00.000Z',
        items: [{ id: 1, quantity: 1, product: { name: 'Espresso' } }],
      },
      {
        id: 202,
        status: 'in_progress',
        created_at: '2026-11-18T10:30:00.000Z',
        items: [{ id: 2, quantity: 2, product: { name: 'Latte' } }],
      },
      {
        id: 203,
        status: 'pending',
        created_at: '2026-11-18T10:00:00.000Z',
        items: [{ id: 3, quantity: 1, product: { name: 'Mocha' } }],
      },
    ]

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' && url.pathname === '/inventory',
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 1, name: 'Espresso', price: 3.5, stock: 25 },
          ]),
        })
      }
    )

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' && url.pathname === '/orders',
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        const urlObj = new URL(route.request().url())
        const status = urlObj.searchParams.get('status') || ''
        const limit = Number(urlObj.searchParams.get('limit') || '20')
        const offset = Number(urlObj.searchParams.get('offset') || '0')

        const filtered = status
          ? allOrders.filter((o) => o.status === status)
          : allOrders
        const slice = filtered.slice(offset, offset + limit)
        const hasMore = offset + limit < filtered.length

        await route.fulfill({
          status: 200,
          headers: { ...CORS_HEADERS, 'x-has-more': String(hasMore) },
          contentType: 'application/json',
          body: JSON.stringify(slice),
        })
      }
    )

    await page.route('http://localhost:8000/orders/*/cancel', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS_HEADERS })
        return
      }
      const match = route
        .request()
        .url()
        .match(/\/orders\/(\d+)\/cancel$/)
      const orderId = match ? Number(match[1]) : -1
      allOrders = allOrders.map((o) =>
        o.id === orderId ? { ...o, status: 'cancelled' } : o
      )
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: 'application/json',
        body: JSON.stringify({ id: orderId, status: 'cancelled', items: [] }),
      })
    })

    await page.goto('/orders', { waitUntil: 'domcontentloaded' })
    const ordersHeading = page.locator('#orders-heading')
    await expect(ordersHeading).toBeVisible()
    await expect(ordersHeading).toHaveAttribute('tabindex', '-1')

    // 1. Cancel visible row (#202) with Enter -> focus hands off to sibling View button
    const row202 = page.locator('tbody tr').filter({
      has: page.getByRole('rowheader', { name: '202', exact: true }),
    })
    const cancel202 = page.getByRole('button', { name: 'Cancel order #202' })
    const view202 = page.getByRole('button', { name: 'View order #202' })
    await cancel202.focus()
    await page.keyboard.press('Enter')
    await expect(row202).toContainText('cancelled')
    await expect(view202).toBeFocused()
    await assertActiveElementNotBody(page)

    // 2. Filter by status="pending", then press Space on Clear Filters -> focus moves to #orders-status-filter
    const statusFilter = page.locator('#orders-status-filter')
    await statusFilter.selectOption('pending')
    const clearFiltersBtn = page.getByRole('button', { name: 'Clear Filters' })
    await expect(clearFiltersBtn).toBeVisible()
    await clearFiltersBtn.focus()
    await page.keyboard.press('Space')
    await expect(clearFiltersBtn).toHaveCount(0)
    await expect(statusFilter).toBeFocused()
    await assertActiveElementNotBody(page)

    // 3. Re-apply status="pending" (rows 201 and 203), cancel 201 -> focus moves to row 203, then cancel 203 -> #orders-heading
    await statusFilter.selectOption('pending')
    const row201 = page.locator('tbody tr').filter({
      has: page.getByRole('rowheader', { name: '201', exact: true }),
    })
    const row203 = page.locator('tbody tr').filter({
      has: page.getByRole('rowheader', { name: '203', exact: true }),
    })
    await expect(row201).toBeVisible()
    await expect(row203).toBeVisible()

    const cancel201 = page.getByRole('button', { name: 'Cancel order #201' })
    await cancel201.focus()
    await page.keyboard.press('Enter')
    await expect(row201).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'View order #203' })
    ).toBeFocused()

    const cancel203 = page.getByRole('button', { name: 'Cancel order #203' })
    await cancel203.focus()
    await page.keyboard.press('Space')
    await expect(row203).toHaveCount(0)
    await expect(ordersHeading).toBeFocused()
    await assertActiveElementNotBody(page)

    // 4. Pagination boundaries: seed 25 orders (2 pages at pageSize=20)
    allOrders = Array.from({ length: 25 }, (_, idx) => ({
      id: 300 + idx,
      status: 'pending',
      created_at: '2026-11-18T12:00:00.000Z',
      items: [],
    }))
    const clearBtn2 = page.getByRole('button', { name: 'Clear Filters' })
    await clearBtn2.focus()
    await page.keyboard.press('Enter')
    await expect(statusFilter).toBeFocused()

    const nextBtn = page.getByRole('button', { name: 'Next' })
    const prevBtn = page.getByRole('button', { name: 'Previous' })
    await expect(nextBtn).toBeEnabled()
    await expect(prevBtn).toBeDisabled()

    // Step Next onto final page 2 -> Next disables, focus moves to Previous
    await nextBtn.focus()
    await page.keyboard.press('Enter')
    await expect(prevBtn).toBeEnabled()
    await expect(nextBtn).toBeDisabled()
    await expect(prevBtn).toBeFocused()

    // Step Previous back onto page 1 -> Previous disables, focus moves to Next
    await page.keyboard.press('Enter')
    await expect(prevBtn).toBeDisabled()
    await expect(nextBtn).toBeEnabled()
    await expect(nextBtn).toBeFocused()
    await assertActiveElementNotBody(page)
  })

  test('Users: deleting rows with keyboard moves focus to adjacent Delete button and #existing-users-heading when empty', async ({
    page,
  }) => {
    await installAuthAndBlockWs(page)

    let users = [
      { id: 1, username: 'alice', is_manager: true },
      { id: 2, username: 'bob', is_manager: false },
      { id: 3, username: 'carol', is_manager: false },
    ]

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' && url.pathname === '/users',
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify(users),
        })
      }
    )

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' &&
        /^\/users\/\d+$/.test(url.pathname),
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        const id = Number(route.request().url().split('/').pop())
        users = users.filter((u) => u.id !== id)
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'User deleted' }),
        })
      }
    )

    await page.goto('/users', { waitUntil: 'domcontentloaded' })
    const existingHeading = page.locator('#existing-users-heading')
    await expect(existingHeading).toBeVisible()
    await expect(existingHeading).toHaveAttribute('tabindex', '-1')

    const deleteBob = page.getByRole('button', { name: 'Delete user bob' })
    const deleteCarol = page.getByRole('button', { name: 'Delete user carol' })
    const deleteAlice = page.getByRole('button', { name: 'Delete user alice' })

    // Delete middle user (bob) -> focus moves to next user (carol)
    await deleteBob.focus()
    await page.keyboard.press('Enter')
    await expect(deleteBob).toHaveCount(0)
    await expect(deleteCarol).toBeFocused()

    // Delete last user (carol) -> focus moves to previous user (alice)
    await page.keyboard.press('Space')
    await expect(deleteCarol).toHaveCount(0)
    await expect(deleteAlice).toBeFocused()

    // Delete final user (alice) -> focus moves to #existing-users-heading
    await page.keyboard.press('Enter')
    await expect(deleteAlice).toHaveCount(0)
    await expect(existingHeading).toBeFocused()
    await assertActiveElementNotBody(page)
  })

  test('Inventory: deleting products with keyboard moves focus to adjacent Delete button and Products heading when empty', async ({
    page,
  }) => {
    await installAuthAndBlockWs(page)

    let products = [
      { id: 1, name: 'Espresso', price: 3.0, stock: 15 },
      { id: 2, name: 'Latte', price: 4.5, stock: 20 },
      { id: 3, name: 'Cold Brew', price: 4.75, stock: 10 },
    ]

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' && url.pathname === '/inventory',
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify(products),
        })
      }
    )

    await page.route(
      (url) =>
        url.origin === 'http://localhost:8000' &&
        /^\/inventory\/\d+$/.test(url.pathname),
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: CORS_HEADERS })
          return
        }
        const id = Number(route.request().url().split('/').pop())
        products = products.filter((p) => p.id !== id)
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Product deleted' }),
        })
      }
    )

    await page.goto('/inventory', { waitUntil: 'domcontentloaded' })
    const productsHeading = page.locator('#products-heading')
    await expect(productsHeading).toBeVisible()
    await expect(productsHeading).toHaveAttribute('tabindex', '-1')

    const deleteLatte = page.getByRole('button', { name: 'Delete Latte' })
    const deleteColdBrew = page.getByRole('button', {
      name: 'Delete Cold Brew',
    })
    const deleteEspresso = page.getByRole('button', { name: 'Delete Espresso' })

    // Delete middle product (Latte) -> focus moves to Cold Brew's Delete button
    await deleteLatte.focus()
    await page.keyboard.press('Enter')
    await expect(deleteLatte).toHaveCount(0)
    await expect(deleteColdBrew).toBeFocused()

    // Delete last product (Cold Brew) -> focus moves to Espresso's Delete button
    await page.keyboard.press('Space')
    await expect(deleteColdBrew).toHaveCount(0)
    await expect(deleteEspresso).toBeFocused()

    // Delete final product (Espresso) -> focus moves to Products heading
    await page.keyboard.press('Enter')
    await expect(deleteEspresso).toHaveCount(0)
    await expect(productsHeading).toBeFocused()
    await assertActiveElementNotBody(page)
  })
})
