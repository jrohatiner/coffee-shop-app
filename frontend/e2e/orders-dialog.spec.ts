import { expect, Page, test } from '@playwright/test'

type MockOrder = {
  id: number
  status: string
  created_at: string
  items: { id: number; quantity: number; product: { name: string } }[]
}

const INITIAL_PRODUCTS = [
  { id: 1, name: 'Espresso', price: 3.5, stock: 25 },
  { id: 2, name: 'Cappuccino', price: 4.75, stock: 18 },
  { id: 3, name: 'Cold Brew', price: 4.25, stock: 12 },
]

const INITIAL_ORDERS: MockOrder[] = [
  {
    id: 101,
    status: 'pending',
    created_at: '2026-11-18T09:15:00.000Z',
    items: [
      { id: 1, quantity: 2, product: { name: 'Espresso' } },
      { id: 2, quantity: 1, product: { name: 'Cappuccino' } },
    ],
  },
  {
    id: 102,
    status: 'in_progress',
    created_at: '2026-11-18T09:30:00.000Z',
    items: [{ id: 3, quantity: 1, product: { name: 'Cold Brew' } }],
  },
  {
    id: 103,
    status: 'completed',
    created_at: '2026-11-18T09:45:00.000Z',
    items: [{ id: 4, quantity: 3, product: { name: 'Espresso' } }],
  },
]

function createMockJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'barista@coffeeshop.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url')
  return `${header}.${payload}.mock-signature`
}

async function setupOrdersPage(page: Page, initialOrders: MockOrder[] = INITIAL_ORDERS) {
  let currentOrders = structuredClone(initialOrders)
  const token = createMockJwt()

  await page.addInitScript((jwt) => {
    window.localStorage.setItem('token', jwt)
  }, token)

  await page.route('**/ws/**', async (route) => {
    await route.abort()
  })

  await page.route(
    (url) => url.origin === 'http://localhost:8000' && url.pathname === '/inventory',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(INITIAL_PRODUCTS),
      })
    }
  )

  await page.route(
    (url) => url.origin === 'http://localhost:8000' && url.pathname === '/orders',
    async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON()
        const created: MockOrder = {
          id: 104,
          status: body.status ?? 'pending',
          created_at: '2026-11-18T10:00:00.000Z',
          items: (body.items ?? []).map((item: { product_id: number; quantity: number }, idx: number) => ({
            id: 10 + idx,
            quantity: item.quantity,
            product: {
              name: INITIAL_PRODUCTS.find((p) => p.id === item.product_id)?.name ?? 'Item',
            },
          })),
        }
        currentOrders = [created, ...currentOrders]
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'x-has-more': 'false' },
        body: JSON.stringify(currentOrders),
      })
    }
  )

  await page.route('http://localhost:8000/orders/*/cancel', async (route) => {
    const match = route.request().url().match(/\/orders\/(\d+)\/cancel$/)
    const orderId = match ? Number(match[1]) : -1
    currentOrders = currentOrders.map((o) => (o.id === orderId ? { ...o, status: 'cancelled' } : o))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible()

  return {
    setOrders: (nextOrders: MockOrder[]) => {
      currentOrders = structuredClone(nextOrders)
    },
  }
}

test.describe('Orders page OrderDetailModal accessibility & keyboard navigation', () => {
  test('exposes modal dialog role, accessible name via aria-labelledby, and moves initial focus inside dialog', async ({
    page,
  }) => {
    await setupOrdersPage(page)

    await expect(page.getByRole('dialog')).toHaveCount(0)

    const secondOrderRow = page.locator('tbody tr', { hasText: '102' })
    const viewButton = secondOrderRow.getByRole('button', { name: 'View' })
    await viewButton.focus()
    await viewButton.click()

    const dialog = page.getByRole('dialog', { name: 'Order #102' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')

    const labelledBy = await dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()

    const heading = dialog.getByRole('heading', { name: 'Order #102', level: 2 })
    await expect(heading).toHaveAttribute('id', labelledBy!)

    const closeButton = dialog.getByRole('button', { name: 'Close' })
    await expect(closeButton).toBeFocused()
    await expect(closeButton).toHaveClass(/hover:bg-gray-100/)

    // Verify p-0 on <dialog> and backdrop:bg-black/30 on ::backdrop
    const styles = await dialog.evaluate((el) => {
      const dialogStyle = window.getComputedStyle(el)
      const backdropStyle = window.getComputedStyle(el, '::backdrop')
      return {
        padding: dialogStyle.padding,
        backdropBg: backdropStyle.backgroundColor,
      }
    })
    expect(styles.padding).toBe('0px')
    expect(styles.backdropBg).toBe('rgba(0, 0, 0, 0.3)')
  })

  test('traps Tab and Shift+Tab focus within the open modal and prevents focusing background controls', async ({
    page,
  }) => {
    await setupOrdersPage(page)

    const firstViewButton = page.locator('tbody tr', { hasText: '101' }).getByRole('button', { name: 'View' })
    await firstViewButton.click()

    const dialog = page.getByRole('dialog', { name: 'Order #101' })
    await expect(dialog).toBeVisible()

    // Press Tab repeatedly (more times than total background controls in nav + main)
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab')
      const activeInsideModal = await page.evaluate(() => {
        const dlg = document.querySelector('dialog')
        const active = document.activeElement
        // In automated headless browsers, cycling a single-control native <dialog> may briefly pass through body/documentElement
        // between top-layer wrap cycles, but MUST NEVER focus any background control outside <dialog>.
        const isBackgroundElement =
          active !== null &&
          active !== document.body &&
          active !== document.documentElement &&
          !dlg?.contains(active)
        return {
          isBackgroundElement,
          activeTag: active?.tagName,
          activeText: active?.textContent?.trim(),
        }
      })
      expect(activeInsideModal.isBackgroundElement).toBe(false)
    }

    // Also verify Shift+Tab never reaches background controls
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab')
      const isBackgroundFocused = await page.evaluate(() => {
        const dlg = document.querySelector('dialog')
        const active = document.activeElement
        return (
          active !== null &&
          active !== document.body &&
          active !== document.documentElement &&
          !dlg?.contains(active)
        )
      })
      expect(isBackgroundFocused).toBe(false)
    }
  })

  test('dismisses on Escape and restores focus to the triggering View button', async ({ page }) => {
    await setupOrdersPage(page)

    const row = page.locator('tbody tr', { hasText: '102' })
    const viewButton = row.getByRole('button', { name: 'View' })
    await viewButton.focus()
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Order #102' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()

    await page.keyboard.press('Escape')

    await expect(dialog).toHaveCount(0)
    await expect(viewButton).toBeFocused()
  })

  test('dismisses on backdrop click outside card, ignores clicks inside card, and restores focus', async ({
    page,
  }) => {
    await setupOrdersPage(page)

    const row = page.locator('tbody tr', { hasText: '101' })
    const viewButton = row.getByRole('button', { name: 'View' })
    await viewButton.click()

    const dialog = page.getByRole('dialog', { name: 'Order #101' })
    await expect(dialog).toBeVisible()

    // Clicking inside the dialog card content must NOT close the modal
    await dialog.getByText('Status: pending').click()
    await expect(dialog).toBeVisible()

    // Clicking on the backdrop outside the dialog bounding box MUST close the modal and restore focus
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(Math.max(5, box!.x - 40), Math.max(5, box!.y - 40))

    await expect(dialog).toHaveCount(0)
    await expect(viewButton).toBeFocused()
  })

  test('dismisses via Close button, restores focus, and handles disconnected trigger gracefully', async ({
    page,
  }) => {
    await setupOrdersPage(page)

    const row = page.locator('tbody tr', { hasText: '103' })
    const viewButton = row.getByRole('button', { name: 'View' })
    await viewButton.click()

    const dialog = page.getByRole('dialog', { name: 'Order #103' })
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(viewButton).toBeFocused()

    // Reopen and simulate row removal while open (e.g., live refresh removing the trigger node)
    await viewButton.click()
    await expect(dialog).toBeVisible()
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr'))
      const targetRow = rows.find((r) => r.textContent?.includes('103'))
      targetRow?.remove()
    })

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('preserves order creation and order cancellation workflows on /orders', async ({ page }) => {
    await setupOrdersPage(page)

    // Create a new order
    await page.getByRole('spinbutton').first().fill('2')
    await page.getByRole('button', { name: 'Create Order' }).click()

    const createdRow = page.locator('tbody tr', { hasText: '104' })
    await expect(createdRow).toBeVisible()

    // View the newly created order in the refactored native <dialog>
    await createdRow.getByRole('button', { name: 'View' }).click()
    const dialog = page.getByRole('dialog', { name: 'Order #104' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Espresso × 2')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Cancel an order
    const pendingRow = page.locator('tbody tr', { hasText: '101' })
    await pendingRow.getByRole('button', { name: 'Cancel' }).click()
    await expect(pendingRow).toContainText('cancelled')
  })
})
