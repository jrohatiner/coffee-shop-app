import { expect, Page, test } from '@playwright/test'

function createJwt(sub: string, expOffsetSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

async function mockBackendApi(page: Page, validJwt: string) {
  await page.route('**/ws/**', async (route) => {
    await route.abort()
  })

  await page.route('http://localhost:8000/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/auth/token') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: validJwt, token_type: 'bearer' }),
      })
      return
    }
    if (url.pathname === '/dashboard/summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalSales: 284.5,
          recentOrders: [
            { id: 101, status: 'completed', created_at: '2026-11-20T15:30:00Z' },
          ],
        }),
      })
      return
    }
    if (url.pathname === '/orders') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'x-has-more': 'false' },
        body: JSON.stringify([
          { id: 101, status: 'completed', created_at: '2026-11-20T15:30:00Z' },
        ]),
      })
      return
    }
    if (url.pathname === '/inventory') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, name: 'Espresso', price: 3.5, stock: 25 }]),
      })
      return
    }
    if (url.pathname.startsWith('/reports/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, report_type: 'daily', total_sales: 284.5 }]),
      })
      return
    }
    if (url.pathname === '/users') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'manager@coffeeshop.example', is_manager: true },
        ]),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

test.describe('AuthProvider navigation, hydration parity, and session sync', () => {
  test('signs in, navigates all 5 protected routes, reloads without hydration warnings, and handles logout + expired tokens', async ({
    page,
  }) => {
    const validJwt = createJwt('manager@coffeeshop.example', 3600)
    await mockBackendApi(page, validJwt)

    const hydrationWarnings: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        const text = msg.text()
        if (/hydrat|did not match|server HTML/i.test(text)) {
          hydrationWarnings.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      if (/hydrat|did not match|server HTML/i.test(err.message)) {
        hydrationWarnings.push(err.message)
      }
    })

    // Sign in on /login -> Dashboard
    await page.goto('/login')
    await page.getByLabel('Username').fill('manager@coffeeshop.example')
    await page.getByLabel('Password').fill('secret123')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
      timeout: 15000,
    })

    // Navigate across all five protected pages via Navbar links
    await page.getByRole('link', { name: 'Orders' }).click()
    await expect(page).toHaveURL(/\/orders$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible({
      timeout: 15000,
    })

    await page.getByRole('link', { name: 'Inventory' }).click()
    await expect(page).toHaveURL(/\/inventory$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible({
      timeout: 15000,
    })

    await page.getByRole('link', { name: 'Reports' }).click()
    await expect(page).toHaveURL(/\/reports$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'Sales Reports', level: 1 })).toBeVisible({
      timeout: 15000,
    })

    await page.getByRole('link', { name: 'Users' }).click()
    await expect(page).toHaveURL(/\/users$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'User Management', level: 1 })).toBeVisible({
      timeout: 15000,
    })

    // Hard reload on protected route produces zero hydration warnings
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible({
      timeout: 15000,
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible({
      timeout: 15000,
    })
    expect(hydrationWarnings).toEqual([])

    // Logout clears token and navigates to /login
    await page.getByRole('button', { name: 'Logout' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeNull()

    // Visiting /orders with an expired JWT clears localStorage and redirects to /login once
    const expiredJwt = createJwt('expired@coffeeshop.example', -120)
    await page.evaluate((jwt) => window.localStorage.setItem('token', jwt), expiredJwt)
    await page.goto('/orders')
    await expect(page).toHaveURL(/\/login$/)
    expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeNull()
    expect(hydrationWarnings).toEqual([])
  })
})
