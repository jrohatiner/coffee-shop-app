import React from 'react'
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
}

jest.mock('../lib/api', () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => mockApi.get(...args),
    post: (...args: any[]) => mockApi.post(...args),
    put: (...args: any[]) => mockApi.put(...args),
    delete: (...args: any[]) => mockApi.delete(...args),
  },
}))

const mockToast = jest.fn()
jest.mock('../components/ui/use-toast', () => ({
  toast: (...args: any[]) => mockToast(...args),
}))

const mockUser = { exp: 4102444800, sub: 'manager' }
let currentAuthUser: { exp: number; sub: string } | null = mockUser
jest.mock('../hooks/useAuth', () => ({
  useAuth: () => currentAuthUser,
}))

type Listener = (...args: any[]) => void
let socketListeners: Record<string, Listener[]> = {}
const mockSocket = {
  on: jest.fn((event: string, cb: Listener) => {
    socketListeners[event] = socketListeners[event] || []
    socketListeners[event].push(cb)
  }),
  disconnect: jest.fn(),
}
const mockUseSocket = jest.fn((onReady?: (s: any) => void, enabled = true) => {
  React.useEffect(() => {
    if (enabled && onReady) onReady(mockSocket)
  }, [onReady, enabled])
  return { current: enabled ? mockSocket : null }
})
jest.mock('../hooks/useSocket', () => ({
  useSocket: (onReady?: (s: any) => void, enabled?: boolean) => mockUseSocket(onReady, enabled),
}))

const inputRenderSpy = jest.fn()
jest.mock('../components/ui/Input', () => {
  const actual = jest.requireActual('../components/ui/Input')
  const WrappedInput = React.forwardRef((props: any, ref: any) => {
    inputRenderSpy(props)
    return React.createElement(actual.Input, { ...props, ref })
  })
  WrappedInput.displayName = 'WrappedInput'
  return {
    __esModule: true,
    Input: WrappedInput,
    default: WrappedInput,
  }
})

const buttonRenderSpy = jest.fn()
jest.mock('../components/ui/Button', () => {
  const actual = jest.requireActual('../components/ui/Button')
  const WrappedButton = React.forwardRef((props: any, ref: any) => {
    buttonRenderSpy(props)
    return React.createElement(actual.Button, { ...props, ref })
  })
  WrappedButton.displayName = 'WrappedButton'
  return {
    __esModule: true,
    Button: WrappedButton,
    default: WrappedButton,
  }
})

const tableRenderSpy = jest.fn()
jest.mock('../components/ui/Table', () => {
  const actual = jest.requireActual('../components/ui/Table')
  const WrappedTable = (props: any) => {
    tableRenderSpy(props)
    return React.createElement(actual.Table, props)
  }
  return {
    __esModule: true,
    ...actual,
    Table: WrappedTable,
    default: WrappedTable,
  }
})

const modalRenderSpy = jest.fn()
jest.mock('../components/OrderDetailModal', () => {
  const actual = jest.requireActual('../components/OrderDetailModal')
  const WrappedModal = (props: any) => {
    modalRenderSpy(props)
    return React.createElement(actual.default, props)
  }
  return {
    __esModule: true,
    default: WrappedModal,
  }
})

import Inventory, { CreateProductForm, ProductRow } from '../pages/inventory'
import Users, { CreateUserForm, UserRow } from '../pages/users'
import Orders, { OrderCreator, OrdersTable, ProductPickerRow } from '../pages/orders'
import Reports from '../pages/reports'

const flushPromises = () => new Promise(resolve => setImmediate(resolve))

function resetAllSpies() {
  inputRenderSpy.mockClear()
  buttonRenderSpy.mockClear()
  tableRenderSpy.mockClear()
  modalRenderSpy.mockClear()
}

function getVisibleButtonText(b: ReactTestInstance): string {
  return b.children
    .filter((child): child is string => typeof child === 'string')
    .join('')
    .trim()
}

function findButtonByText(root: ReactTestInstance, label: string): ReactTestInstance {
  const buttons = root.findAllByType('button')
  const match = buttons.find(b => getVisibleButtonText(b) === label)
  if (!match) throw new Error(`Button "${label}" not found`)
  return match
}

function findAllMemo(root: ReactTestInstance, memoComp: any): ReactTestInstance[] {
  return root.findAllByType(memoComp.type ?? memoComp)
}

describe('Staff pages state isolation and row memoization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    socketListeners = {}
    currentAuthUser = mockUser
  })

  describe('Inventory page', () => {
    const makeProducts = () => [
      { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
      { id: 2, name: 'Latte', price: 4.5, stock: 20 },
      { id: 3, name: 'Cappuccino', price: 4.25, stock: 15 },
      { id: 4, name: 'Cold Brew', price: 5.0, stock: 8 },
    ]

    test('typing in CreateProductForm causes zero ProductRow renders and preserves input on failed POST', async () => {
      const initialProducts = makeProducts()
      mockApi.get.mockResolvedValue({ data: initialProducts })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Inventory />)
        await flushPromises()
      })

      expect(findAllMemo(renderer.root, ProductRow)).toHaveLength(4)
      resetAllSpies()

      const createForm = findAllMemo(renderer.root, CreateProductForm)[0]
      const [nameInput, priceInput, stockInput] = createForm.findAllByType('input')

      await act(async () => {
        nameInput.props.onChange({ target: { value: 'Flat White' } })
        priceInput.props.onChange({ target: { value: '4.75' } })
        stockInput.props.onChange({ target: { value: '30' } })
      })

      // Zero renders of ProductRow inputs (which have no placeholder) or Save/Delete buttons
      const rowInputRenders = inputRenderSpy.mock.calls.filter(([props]) => !props.placeholder)
      const rowButtonRenders = buttonRenderSpy.mock.calls.filter(
        ([props]) => props.children === 'Save' || props.children === 'Delete'
      )
      expect(rowInputRenders).toHaveLength(0)
      expect(rowButtonRenders).toHaveLength(0)

      // Failed POST preserves form state
      mockApi.post.mockRejectedValueOnce({ response: { data: { detail: 'Duplicate name' } } })
      const addButton = findButtonByText(renderer.root, 'Add Product')
      await act(async () => {
        await addButton.props.onClick()
      })

      const afterFailInputs = findAllMemo(renderer.root, CreateProductForm)[0].findAllByType(
        'input'
      )
      expect(afterFailInputs[0].props.value).toBe('Flat White')
      expect(afterFailInputs[1].props.value).toBe('4.75')
      expect(afterFailInputs[2].props.value).toBe('30')

      // Successful POST resets form state and reloads inventory
      mockApi.post.mockResolvedValueOnce({ data: { id: 5 } })
      await act(async () => {
        await addButton.props.onClick()
        await flushPromises()
      })

      expect(mockApi.post).toHaveBeenLastCalledWith('/inventory', {
        name: 'Flat White',
        price: 4.75,
        stock: 30,
      })
      const afterSuccessInputs = findAllMemo(renderer.root, CreateProductForm)[0].findAllByType(
        'input'
      )
      expect(afterSuccessInputs[0].props.value).toBe('')
      expect(afterSuccessInputs[1].props.value).toBe('')
      expect(afterSuccessInputs[2].props.value).toBe('')

      renderer.unmount()
    })

    test('ProductRow edits draft immutably without re-rendering sibling rows, syncs on stock_update, and deletes', async () => {
      const initialProducts = makeProducts()
      const originalFirst = initialProducts[0]
      mockApi.get.mockResolvedValue({ data: initialProducts })
      mockApi.put.mockResolvedValue({ data: {} })
      mockApi.delete.mockResolvedValue({ data: {} })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Inventory />)
        await flushPromises()
      })

      const rows = findAllMemo(renderer.root, ProductRow)
      const firstRowInputs = rows[0].findAllByType('input')
      resetAllSpies()

      await act(async () => {
        firstRowInputs[0].props.onChange({ target: { value: 'Double Espresso' } })
      })
      await act(async () => {
        firstRowInputs[1].props.onChange({ target: { value: '3.75' } })
      })
      await act(async () => {
        firstRowInputs[2].props.onChange({ target: { value: '14' } })
      })

      // Original product object was never mutated in place
      expect(originalFirst).toEqual({ id: 1, name: 'Espresso', price: 3.0, stock: 10 })

      // Only row 0 re-rendered across the 3 field edits (3 Save button renders total, 0 for rows 1..3)
      const saveButtonRenders = buttonRenderSpy.mock.calls.filter(
        ([props]) => props.children === 'Save'
      )
      expect(saveButtonRenders).toHaveLength(3)

      // Saving sends a new object with updated draft values while keeping original unmutated
      mockApi.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'Double Espresso', price: 3.75, stock: 14 },
          ...initialProducts.slice(1),
        ],
      })
      const firstRowSave = findButtonByText(rows[0], 'Save')
      await act(async () => {
        await firstRowSave.props.onClick()
        await flushPromises()
      })

      expect(mockApi.put).toHaveBeenCalledWith('/inventory/1', {
        id: 1,
        name: 'Double Espresso',
        price: 3.75,
        stock: 14,
      })
      expect(originalFirst).toEqual({ id: 1, name: 'Espresso', price: 3.0, stock: 10 })

      // Server stock_update event refreshes draft values via useEffect
      mockApi.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'Double Espresso', price: 3.75, stock: 6 },
          ...initialProducts.slice(1),
        ],
      })
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb => cb())
        await flushPromises()
      })

      const updatedFirstRowInputs = findAllMemo(renderer.root, ProductRow)[0]
        .findAllByType('input')
      expect(updatedFirstRowInputs[2].props.value).toBe('6')

      // Deleting a row invokes DELETE /inventory/:id
      const secondRowDelete = findButtonByText(findAllMemo(renderer.root, ProductRow)[1], 'Delete')
      mockApi.get.mockResolvedValueOnce({ data: initialProducts.filter(p => p.id !== 2) })
      await act(async () => {
        await secondRowDelete.props.onClick()
        await flushPromises()
      })
      expect(mockApi.delete).toHaveBeenCalledWith('/inventory/2')

      renderer.unmount()
    })

    test('reconciles authoritative POST/PUT/DELETE responses and remote stock_update deltas with zero GET /inventory calls while preserving sibling drafts', async () => {
      const initialProducts = makeProducts()
      mockApi.get.mockResolvedValue({ data: initialProducts })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Inventory />)
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenCalledTimes(1)
      mockApi.get.mockClear()
      mockToast.mockClear()

      // Edit unsaved draft on sibling row #2 (Latte) so we can verify remote updates do not wipe it
      const initialRows = findAllMemo(renderer.root, ProductRow)
      await act(async () => {
        initialRows[1].findAllByType('input')[0].props.onChange({ target: { value: 'Iced Latte Draft' } })
      })

      // 1. Authoritative POST /inventory appends in place, triggers 0 GET /inventory calls, suppresses echo toast
      const createForm = findAllMemo(renderer.root, CreateProductForm)[0]
      const [nameInput, priceInput, stockInput] = createForm.findAllByType('input')
      await act(async () => {
        nameInput.props.onChange({ target: { value: 'Matcha Latte' } })
        priceInput.props.onChange({ target: { value: '5.50' } })
        stockInput.props.onChange({ target: { value: '25' } })
      })

      const createdProduct = { id: 5, name: 'Matcha Latte', price: 5.5, stock: 25 }
      mockApi.post.mockResolvedValueOnce({ data: createdProduct })
      const addButton = findButtonByText(renderer.root, 'Add Product')
      await act(async () => {
        await addButton.props.onClick()
        await flushPromises()
      })

      expect(findAllMemo(renderer.root, ProductRow)).toHaveLength(5)
      expect(mockApi.get).not.toHaveBeenCalled()
      expect(mockToast).toHaveBeenCalledTimes(1)
      expect(mockToast).toHaveBeenCalledWith({ title: 'Product created', description: 'Matcha Latte' })

      // Local socket echo for create is suppressed (no Inventory Changed toast, no GET /inventory)
      mockToast.mockClear()
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({ updated: [createdProduct], deleted_ids: [] })
        )
        await flushPromises()
      })
      expect(mockToast).not.toHaveBeenCalled()
      expect(mockApi.get).not.toHaveBeenCalled()

      // 2. Authoritative PUT /inventory/1 updates row in place, skips sibling renders, suppresses echo toast
      const rowsAfterCreate = findAllMemo(renderer.root, ProductRow)
      await act(async () => {
        rowsAfterCreate[0].findAllByType('input')[2].props.onChange({ target: { value: '42' } })
      })
      resetAllSpies()
      mockToast.mockClear()

      const updatedEspresso = { id: 1, name: 'Espresso', price: 3.0, stock: 42 }
      mockApi.put.mockResolvedValueOnce({ data: updatedEspresso })
      const saveRow0 = findButtonByText(rowsAfterCreate[0], 'Save')
      await act(async () => {
        await saveRow0.props.onClick()
        await flushPromises()
      })

      expect(mockApi.get).not.toHaveBeenCalled()
      expect(mockToast).toHaveBeenCalledTimes(1)
      expect(mockToast).toHaveBeenCalledWith({ title: 'Saved', description: 'Espresso' })

      mockToast.mockClear()
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({ updated: [updatedEspresso], deleted_ids: [] })
        )
        await flushPromises()
      })
      expect(mockToast).not.toHaveBeenCalled()
      expect(mockApi.get).not.toHaveBeenCalled()

      // 3. Authoritative DELETE /inventory/4 removes row in place and suppresses echo toast
      mockToast.mockClear()
      mockApi.delete.mockResolvedValueOnce({ data: { detail: 'Product deleted' } })
      const row4Delete = findButtonByText(findAllMemo(renderer.root, ProductRow)[3], 'Delete')
      await act(async () => {
        await row4Delete.props.onClick()
        await flushPromises()
      })

      expect(findAllMemo(renderer.root, ProductRow)).toHaveLength(4)
      expect(mockApi.get).not.toHaveBeenCalled()
      expect(mockToast).toHaveBeenCalledTimes(1)
      expect(mockToast).toHaveBeenCalledWith({ title: 'Product deleted' })

      mockToast.mockClear()
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({ updated: [], deleted_ids: [4] })
        )
        await flushPromises()
      })
      expect(mockToast).not.toHaveBeenCalled()
      expect(mockApi.get).not.toHaveBeenCalled()

      // 4. Remote stock_update delta updates affected row only, skips sibling re-renders, preserves unsaved sibling draft
      resetAllSpies()
      mockToast.mockClear()
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({
            updated: [{ id: 3, name: 'Cappuccino', price: 4.25, stock: 9 }],
            deleted_ids: [],
          })
        )
        await flushPromises()
      })

      expect(mockToast).toHaveBeenCalledWith({ title: 'Inventory Changed' })
      expect(mockApi.get).not.toHaveBeenCalled()

      // Only Cappuccino's ProductRow re-rendered (1 Save button render on ProductRow mount/update + Effect sync)
      const currentRows = findAllMemo(renderer.root, ProductRow)
      expect(currentRows[2].findAllByType('input')[2].props.value).toBe('9')
      // Sibling row #2 (Latte) kept its unsaved draft text intact!
      expect(currentRows[1].findAllByType('input')[0].props.value).toBe('Iced Latte Draft')
      const renderedLegends = currentRows.map(r => r.findByType('legend').children.join(''))
      expect(renderedLegends).toEqual(['Espresso', 'Latte', 'Cappuccino', 'Matcha Latte'])

      renderer.unmount()
    })
  })

  describe('Users page', () => {
    const initialUsers = [
      { id: 1, username: 'alice', is_manager: true },
      { id: 2, username: 'bob', is_manager: false },
      { id: 3, username: 'carol', is_manager: false },
    ]

    test('typing in CreateUserForm causes zero UserRow renders, preserves state on failed POST, and supports delete', async () => {
      mockApi.get.mockResolvedValue({ data: initialUsers })
      mockApi.delete.mockResolvedValue({ data: {} })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Users />)
        await flushPromises()
      })

      expect(findAllMemo(renderer.root, UserRow)).toHaveLength(3)
      resetAllSpies()

      const createUserForm = findAllMemo(renderer.root, CreateUserForm)[0]
      const [usernameInput, passwordInput, managerCheckbox] = createUserForm.findAllByType('input')

      await act(async () => {
        usernameInput.props.onChange({ target: { value: 'dave' } })
        passwordInput.props.onChange({ target: { value: 'secret123' } })
        managerCheckbox.props.onChange({ target: { checked: true } })
      })

      const deleteButtonRenders = buttonRenderSpy.mock.calls.filter(
        ([props]) => props.children === 'Delete'
      )
      expect(deleteButtonRenders).toHaveLength(0)

      // Failed POST preserves form input
      mockApi.post.mockRejectedValueOnce(new Error('Network error'))
      const createBtn = findButtonByText(renderer.root, 'Create User')
      await act(async () => {
        await createBtn.props.onClick()
      })

      const afterFailUserInputs = findAllMemo(renderer.root, CreateUserForm)[0].findAllByType(
        'input'
      )
      expect(afterFailUserInputs[0].props.value).toBe('dave')
      expect(afterFailUserInputs[1].props.value).toBe('secret123')
      expect(afterFailUserInputs[2].props.checked).toBe(true)

      // Successful POST resets form and reloads users
      mockApi.post.mockResolvedValueOnce({ data: { id: 4 } })
      await act(async () => {
        await createBtn.props.onClick()
        await flushPromises()
      })

      expect(mockApi.post).toHaveBeenLastCalledWith('/users', {
        username: 'dave',
        password: 'secret123',
        is_manager: true,
      })
      const afterSuccessUserInputs = findAllMemo(renderer.root, CreateUserForm)[0].findAllByType(
        'input'
      )
      expect(afterSuccessUserInputs[0].props.value).toBe('')
      expect(afterSuccessUserInputs[1].props.value).toBe('')
      expect(afterSuccessUserInputs[2].props.checked).toBe(false)

      // Delete user via memoized UserRow callback
      const userRows = findAllMemo(renderer.root, UserRow)
      const secondDeleteBtn = findButtonByText(userRows[1], 'Delete')
      await act(async () => {
        await secondDeleteBtn.props.onClick()
        await flushPromises()
      })
      expect(mockApi.delete).toHaveBeenCalledWith('/users/2')

      renderer.unmount()
    })
  })

  describe('Orders page', () => {
    const sampleProducts = [
      { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
      { id: 2, name: 'Latte', price: 4.5, stock: 20 },
      { id: 3, name: 'Mocha', price: 5.0, stock: 12 },
    ]
    const sampleOrders = [
      {
        id: 101,
        status: 'pending',
        created_at: '2026-01-10T10:00:00Z',
        items: [{ id: 1, quantity: 2, product: { name: 'Espresso' } }],
      },
      {
        id: 102,
        status: 'completed',
        created_at: '2026-01-10T11:00:00Z',
        items: [{ id: 2, quantity: 1, product: { name: 'Latte' } }],
      },
      {
        id: 103,
        status: 'in_progress',
        created_at: '2026-01-10T12:00:00Z',
        items: [{ id: 3, quantity: 1, product: { name: 'Mocha' } }],
      },
    ]

    function setupOrdersApi() {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/orders') return Promise.resolve({ data: sampleOrders })
        if (url.startsWith('/orders/')) {
          const id = Number(url.split('/').pop())
          return Promise.resolve({ data: sampleOrders.find(o => o.id === id) ?? sampleOrders[0] })
        }
        if (url === '/inventory') return Promise.resolve({ data: sampleProducts })
        return Promise.resolve({ data: [] })
      })
    }

    test('cart edits and status changes isolate OrderCreator from OrdersTable and memoize sibling picker rows', async () => {
      setupOrdersApi()

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      expect(findAllMemo(renderer.root, ProductPickerRow)).toHaveLength(3)
      expect(findAllMemo(renderer.root, OrdersTable)).toHaveLength(1)
      resetAllSpies()

      const pickerRows = findAllMemo(renderer.root, ProductPickerRow)
      const firstQtyInput = pickerRows[0].findByType('input')
      const creatorInstance = findAllMemo(renderer.root, OrderCreator)[0]
      const statusSelect = creatorInstance.findByType('select')

      await act(async () => {
        firstQtyInput.props.onChange({ target: { value: '2' } })
      })
      await act(async () => {
        firstQtyInput.props.onChange({ target: { value: '4' } })
      })
      await act(async () => {
        statusSelect.props.onChange({ target: { value: 'in_progress' } })
      })

      // OrdersTable and its View/Cancel buttons rendered 0 times during cart/status edits
      expect(tableRenderSpy).toHaveBeenCalledTimes(0)
      const orderActionRenders = buttonRenderSpy.mock.calls.filter(
        ([props]) => props.children === 'View' || props.children === 'Cancel'
      )
      expect(orderActionRenders).toHaveLength(0)

      // Only Product #1's picker Input re-rendered on the 2 quantity updates; Products #2 & #3 rendered 0 times
      expect(inputRenderSpy).toHaveBeenCalledTimes(2)

      // Failed order POST keeps cart & status intact; successful POST resets both
      mockApi.post.mockRejectedValueOnce({ response: { data: { detail: 'Out of stock' } } })
      const createOrderBtn = findButtonByText(renderer.root, 'Create Order')
      await act(async () => {
        await createOrderBtn.props.onClick()
      })

      expect(findAllMemo(renderer.root, ProductPickerRow)[0].findByType('input').props.value).toBe(
        4
      )
      expect(findAllMemo(renderer.root, OrderCreator)[0].findByType('select').props.value).toBe(
        'in_progress'
      )

      mockApi.post.mockResolvedValueOnce({ data: { id: 104 } })
      await act(async () => {
        await createOrderBtn.props.onClick()
        await flushPromises()
      })

      expect(mockApi.post).toHaveBeenLastCalledWith('/orders', {
        status: 'in_progress',
        items: [{ product_id: 1, quantity: 4 }],
      })
      expect(findAllMemo(renderer.root, ProductPickerRow)[0].findByType('input').props.value).toBe(
        0
      )
      expect(findAllMemo(renderer.root, OrderCreator)[0].findByType('select').props.value).toBe(
        'pending'
      )

      renderer.unmount()
    })

    test('toggling OrderDetailModal open and closed skips OrdersTable and OrderCreator renders', async () => {
      setupOrdersApi()
      mockApi.post.mockResolvedValue({ data: {} })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      resetAllSpies()

      // Open modal for Order #101
      const viewButtons = renderer.root
        .findAllByType('button')
        .filter(b => getVisibleButtonText(b) === 'View')
      await act(async () => {
        viewButtons[0].props.onClick()
        await flushPromises()
      })

      expect(modalRenderSpy).toHaveBeenCalled()
      expect(modalRenderSpy.mock.calls[0][0].order.id).toBe(101)
      expect(tableRenderSpy).toHaveBeenCalledTimes(0)
      expect(inputRenderSpy).toHaveBeenCalledTimes(0)
      expect(
        buttonRenderSpy.mock.calls.filter(
          ([props]) =>
            props.children === 'View' ||
            props.children === 'Cancel' ||
            props.children === 'Create Order'
        )
      ).toHaveLength(0)

      resetAllSpies()

      // Close modal
      const closeBtn = findButtonByText(renderer.root, 'Close')
      await act(async () => {
        closeBtn.props.onClick()
      })

      expect(modalRenderSpy).toHaveBeenCalledTimes(0)
      expect(tableRenderSpy).toHaveBeenCalledTimes(0)
      expect(inputRenderSpy).toHaveBeenCalledTimes(0)
      expect(buttonRenderSpy).toHaveBeenCalledTimes(0)
      expect(findAllMemo(renderer.root, OrderCreator)).toHaveLength(1)

      // Cancel action on active order still works via memoized callback
      const cancelButtons = renderer.root
        .findAllByType('button')
        .filter(b => getVisibleButtonText(b) === 'Cancel')
      expect(cancelButtons).toHaveLength(2) // pending + in_progress (completed has no Cancel button)
      await act(async () => {
        await cancelButtons[0].props.onClick()
        await flushPromises()
      })
      expect(mockApi.post).toHaveBeenCalledWith('/orders/101/cancel')

      renderer.unmount()
    })

    test('preserves pagination/filtering params and local socket echo deduplication without re-rendering OrderCreator', async () => {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/orders') {
          return Promise.resolve({ data: sampleOrders, headers: { 'x-has-more': 'true' } })
        }
        if (url === '/inventory') return Promise.resolve({ data: sampleProducts })
        return Promise.resolve({ data: [] })
      })
      mockApi.post.mockResolvedValue({
        data: { id: 105, status: 'pending', created_at: '2026-01-10T13:00:00Z' },
      })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenCalledWith('/orders', {
        params: { limit: 20, offset: 0 },
      })

      resetAllSpies()

      const statusFilterSelect = renderer.root.findByProps({ id: 'orders-status-filter' })
      const nextBtn = findButtonByText(renderer.root, 'Next')

      await act(async () => {
        nextBtn.props.onClick()
        await flushPromises()
      })
      expect(mockApi.get).toHaveBeenLastCalledWith('/orders', {
        params: { limit: 20, offset: 20 },
      })

      await act(async () => {
        statusFilterSelect.props.onChange({ target: { value: 'pending' } })
        await flushPromises()
      })
      expect(mockApi.get).toHaveBeenLastCalledWith('/orders', {
        params: { limit: 20, offset: 0, status: 'pending' },
      })

      // Changing pagination and filters did not re-render OrderCreator's picker inputs
      const pickerInputRenders = inputRenderSpy.mock.calls.filter(
        ([props]) => props.type === 'number'
      )
      expect(pickerInputRenders).toHaveLength(0)

      // Local order creation suppresses immediate socket new_order & stock_update echoes
      const pickerRows = findAllMemo(renderer.root, ProductPickerRow)
      await act(async () => {
        pickerRows[0].findByType('input').props.onChange({ target: { value: '1' } })
      })

      mockToast.mockClear()
      const createOrderBtn = findButtonByText(renderer.root, 'Create Order')
      await act(async () => {
        await createOrderBtn.props.onClick()
        await flushPromises()
      })
      expect(mockToast).toHaveBeenCalledWith({ title: 'Order created' })

      mockToast.mockClear()
      mockApi.get.mockClear()
      await act(async () => {
        socketListeners['new_order']?.forEach(cb =>
          cb({ id: 105, status: 'pending', created_at: '2026-01-10T13:00:00Z' })
        )
        socketListeners['stock_update']?.forEach(cb => cb())
        await flushPromises()
      })
      // Echoes from our own local create were suppressed; subsequent remote event goes through
      expect(mockToast).not.toHaveBeenCalledWith({ title: 'New Order' })
      expect(mockApi.get).not.toHaveBeenCalled()

      await act(async () => {
        socketListeners['new_order']?.forEach(cb =>
          cb({ id: 106, status: 'pending', created_at: '2026-01-10T14:00:00Z' })
        )
        await flushPromises()
      })
      expect(mockToast).toHaveBeenCalledWith({ title: 'New Order' })
      expect(mockApi.get).not.toHaveBeenCalled()

      renderer.unmount()
    })

    test('reconciles OrderOut.items[].product on create/cancel and remote stock_update deltas in place with zero GET /inventory calls', async () => {
      setupOrdersApi()

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Orders />)
        await flushPromises()
      })

      mockApi.get.mockClear()
      resetAllSpies()

      // 1. Create order returning authoritative OrderOut with items[].product -> 0 GET /inventory calls
      const pickerRows = findAllMemo(renderer.root, ProductPickerRow)
      const firstInputId = pickerRows[0].findByType('input').props.id
      await act(async () => {
        pickerRows[0].findByType('input').props.onChange({ target: { value: '2' } })
      })
      resetAllSpies()

      mockApi.post.mockResolvedValueOnce({
        data: {
          id: 110,
          status: 'pending',
          created_at: '2026-01-10T15:00:00Z',
          items: [
            {
              id: 501,
              product_id: 1,
              quantity: 2,
              product: { id: 1, name: 'Espresso', price: 3.0, stock: 8 },
            },
          ],
        },
      })

      const createOrderBtn = findButtonByText(renderer.root, 'Create Order')
      await act(async () => {
        await createOrderBtn.props.onClick()
        await flushPromises()
      })

      expect(mockApi.get).not.toHaveBeenCalledWith('/inventory')
      expect(findAllMemo(renderer.root, ProductPickerRow)[0].props.product.stock).toBe(8)
      // Sibling picker rows (#2 Latte & #3 Mocha) skipped re-rendering; only Product #1 rendered (stock update + cart reset)
      const numberInputRendersAfterCreate = inputRenderSpy.mock.calls.filter(
        ([props]) => props.type === 'number'
      )
      expect(numberInputRendersAfterCreate.length).toBeGreaterThan(0)
      expect(numberInputRendersAfterCreate.every(([props]) => props.id === firstInputId)).toBe(true)

      // 2. Cancel order returning authoritative OrderOut with restocked items[].product -> 0 GET /inventory calls
      mockApi.get.mockClear()
      resetAllSpies()

      mockApi.post.mockResolvedValueOnce({
        data: {
          id: 110,
          status: 'cancelled',
          created_at: '2026-01-10T15:00:00Z',
          items: [
            {
              id: 501,
              product_id: 1,
              quantity: 2,
              product: { id: 1, name: 'Espresso', price: 3.0, stock: 10 },
            },
          ],
        },
      })

      const cancelButtons = renderer.root
        .findAllByType('button')
        .filter(b => getVisibleButtonText(b) === 'Cancel')
      await act(async () => {
        await cancelButtons[0].props.onClick()
        await flushPromises()
      })

      expect(mockApi.post).toHaveBeenLastCalledWith('/orders/110/cancel')
      expect(mockApi.get).not.toHaveBeenCalledWith('/inventory')
      expect(findAllMemo(renderer.root, ProductPickerRow)[0].props.product.stock).toBe(10)
      const numberInputRendersAfterCancel = inputRenderSpy.mock.calls.filter(
        ([props]) => props.type === 'number'
      )
      expect(numberInputRendersAfterCancel).toHaveLength(1)

      // Consume the local cancel stock_update echo before testing remote stock_update
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({ updated: [{ id: 1, name: 'Espresso', price: 3.0, stock: 10 }], deleted_ids: [] })
        )
        await flushPromises()
      })

      // 3. Remote stock_update delta merges updated/new products and removes deleted_ids with 0 GET /inventory calls
      mockApi.get.mockClear()
      resetAllSpies()

      await act(async () => {
        socketListeners['stock_update']?.forEach(cb =>
          cb({
            updated: [
              { id: 2, name: 'Latte', price: 4.5, stock: 16 },
              { id: 4, name: 'Cortado', price: 3.75, stock: 9 },
            ],
            deleted_ids: [3],
          })
        )
        await flushPromises()
      })

      expect(mockApi.get).not.toHaveBeenCalledWith('/inventory')
      const updatedPickerRows = findAllMemo(renderer.root, ProductPickerRow)
      expect(updatedPickerRows.map(r => r.props.product.id)).toEqual([1, 2, 4])
      expect(updatedPickerRows[1].props.product.stock).toBe(16)
      // Unchanged Product #1 skipped re-rendering; only updated #2 and appended #4 rendered
      const remoteDeltaInputRenders = inputRenderSpy.mock.calls.filter(
        ([props]) => props.type === 'number'
      )
      expect(remoteDeltaInputRenders).toHaveLength(2)

      // 4. Legacy payload-less stock_update falls back to GET /inventory
      mockApi.get.mockClear()
      await act(async () => {
        socketListeners['stock_update']?.forEach(cb => cb())
        await flushPromises()
      })
      expect(mockApi.get).toHaveBeenCalledWith('/inventory')

      renderer.unmount()
    })
  })

  describe('Reports page', () => {
    const makeReports = (period: string, count: number, startId = 1, baseSales = 100) =>
      Array.from({ length: count }, (_, idx) => ({
        id: startId + idx,
        report_type: period,
        total_sales: baseSales + idx * 12.5,
        created_at: `2026-11-${String(Math.min(28, idx + 1)).padStart(2, '0')}T12:00:00Z`,
      }))

    const getTextContent = (node: ReactTestInstance): string =>
      node.children
        .map(child => (typeof child === 'string' ? child : getTextContent(child)))
        .join('')

    const triggerTablistKey = (root: ReactTestInstance, key: string) => {
      const tablistNode = root.findByProps({ role: 'tablist' })
      const tabNodes = tablistNode.findAll(
        n => n.type === 'button' && n.props.role === 'tab'
      )
      const mockTablist: any = {}
      const mockTabs = tabNodes.map(n => ({
        focus: jest.fn(),
        closest: (selector: string) => (selector === '[role="tablist]' || selector === '[role="tablist"]' ? mockTablist : null),
        getAttribute: (attr: string) => {
          if (attr === 'aria-selected') return String(Boolean(n.props['aria-selected']))
          if (attr === 'aria-disabled') return String(Boolean(n.props['aria-disabled']))
          if (attr === 'data-value') return n.props['data-value'] ?? null
          return n.props[attr] ?? null
        },
      }))
      mockTablist.querySelectorAll = () => mockTabs
      const activeIdx = tabNodes.findIndex(n => n.props['aria-selected'] === true)
      const activeTabMock = mockTabs[activeIdx >= 0 ? activeIdx : 0]
      mockTablist.ownerDocument = { activeElement: activeTabMock }
      tablistNode.props.onKeyDown({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: jest.fn(),
        currentTarget: mockTablist,
        target: {
          closest: (selector: string) => (selector === '[role="tab"]' ? activeTabMock : null),
        },
      })
    }

    test('retains cached slices per tab and skips refetching when loadedPage === page', async () => {
      const dailyPage1 = makeReports('daily', 20, 1, 150)
      const weeklyPage1 = makeReports('weekly', 3, 201, 900)

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/reports/daily') {
          return Promise.resolve({ data: dailyPage1, headers: { 'x-has-more': 'true' } })
        }
        if (url === '/reports/weekly') {
          return Promise.resolve({ data: weeklyPage1, headers: { 'x-has-more': 'false' } })
        }
        return Promise.resolve({ data: [], headers: { 'x-has-more': 'false' } })
      })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Reports />)
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenCalledTimes(1)
      expect(mockApi.get).toHaveBeenLastCalledWith(
        '/reports/daily',
        expect.objectContaining({
          params: { limit: 20, offset: 0 },
          signal: expect.any(AbortSignal),
        })
      )

      // Active panel keeps <ul> and <li> markup and enables Next when x-has-more is true
      const dailyItems = renderer.root.findByType('ul').findAllByType('li')
      expect(dailyItems).toHaveLength(20)
      expect(getTextContent(dailyItems[0])).toBe('DAILY — $150.00')
      expect(findButtonByText(renderer.root, 'Previous').props.disabled).toBe(true)
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(false)

      // Switch to Weekly -> fetches /reports/weekly once
      const weeklyTab = findButtonByText(renderer.root, 'Weekly')
      await act(async () => {
        weeklyTab.props.onClick({})
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenCalledTimes(2)
      expect(mockApi.get).toHaveBeenLastCalledWith(
        '/reports/weekly',
        expect.objectContaining({
          params: { limit: 20, offset: 0 },
          signal: expect.any(AbortSignal),
        })
      )
      const weeklyItems = renderer.root.findByType('ul').findAllByType('li')
      expect(weeklyItems).toHaveLength(3)
      expect(getTextContent(weeklyItems[0])).toBe('WEEKLY — $900.00')
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(true)

      // Switch back to Daily -> skips network request and restores cached Daily slice
      const dailyTab = findButtonByText(renderer.root, 'Daily')
      await act(async () => {
        dailyTab.props.onClick({})
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenCalledTimes(2)
      const restoredDailyItems = renderer.root.findByType('ul').findAllByType('li')
      expect(restoredDailyItems).toHaveLength(20)
      expect(getTextContent(restoredDailyItems[0])).toBe('DAILY — $150.00')
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(false)

      renderer.unmount()
    })

    test('pages with Previous and Next and preserves each tab page across tab switches', async () => {
      const dailyPage1 = makeReports('daily', 20, 1, 100)
      const dailyPage2 = makeReports('daily', 5, 21, 400)
      const monthlyPage1 = makeReports('monthly', 2, 301, 3200)

      mockApi.get.mockImplementation((url: string, cfg?: { params?: { offset?: number } }) => {
        if (url === '/reports/daily') {
          if (cfg?.params?.offset === 20) {
            return Promise.resolve({ data: dailyPage2, headers: { 'x-has-more': 'false' } })
          }
          return Promise.resolve({ data: dailyPage1, headers: { 'x-has-more': 'true' } })
        }
        if (url === '/reports/monthly') {
          return Promise.resolve({ data: monthlyPage1, headers: { 'x-has-more': 'false' } })
        }
        return Promise.resolve({ data: [], headers: { 'x-has-more': 'false' } })
      })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Reports />)
        await flushPromises()
      })

      // Advance Daily to page 2
      await act(async () => {
        findButtonByText(renderer.root, 'Next').props.onClick()
        await flushPromises()
      })

      expect(mockApi.get).toHaveBeenLastCalledWith(
        '/reports/daily',
        expect.objectContaining({
          params: { limit: 20, offset: 20 },
          signal: expect.any(AbortSignal),
        })
      )
      expect(renderer.root.findByType('ul').findAllByType('li')).toHaveLength(5)
      expect(getTextContent(renderer.root.findByType('ul').findAllByType('li')[0])).toBe(
        'DAILY — $400.00'
      )
      expect(findButtonByText(renderer.root, 'Previous').props.disabled).toBe(false)
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(true)

      // Switch to Monthly and back to Daily -> Daily stays on cached Page 2 without refetching
      await act(async () => {
        findButtonByText(renderer.root, 'Monthly').props.onClick({})
        await flushPromises()
      })
      expect(mockApi.get).toHaveBeenCalledTimes(3)

      mockApi.get.mockClear()
      await act(async () => {
        findButtonByText(renderer.root, 'Daily').props.onClick({})
        await flushPromises()
      })
      expect(mockApi.get).not.toHaveBeenCalled()
      expect(renderer.root.findByType('ul').findAllByType('li')).toHaveLength(5)
      expect(findButtonByText(renderer.root, 'Previous').props.disabled).toBe(false)
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(true)

      // Navigate Previous on Daily -> fetches page 1 (offset 0)
      await act(async () => {
        findButtonByText(renderer.root, 'Previous').props.onClick()
        await flushPromises()
      })
      expect(mockApi.get).toHaveBeenCalledTimes(1)
      expect(mockApi.get).toHaveBeenLastCalledWith(
        '/reports/daily',
        expect.objectContaining({
          params: { limit: 20, offset: 0 },
          signal: expect.any(AbortSignal),
        })
      )
      expect(renderer.root.findByType('ul').findAllByType('li')).toHaveLength(20)
      expect(findButtonByText(renderer.root, 'Previous').props.disabled).toBe(true)
      expect(findButtonByText(renderer.root, 'Next').props.disabled).toBe(false)

      renderer.unmount()
    })

    test('aborts superseded requests on rapid Arrow/Home/End keypresses without treating canceled promises as load errors', async () => {
      type PendingCall = {
        url: string
        signal: AbortSignal
        resolve: (val: any) => void
        reject: (err: any) => void
      }
      const pendingCalls: PendingCall[] = []

      mockApi.get.mockImplementation((url: string, cfg?: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          pendingCalls.push({
            url,
            signal: cfg!.signal!,
            resolve,
            reject,
          })
        })
      })

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Reports />)
      })

      expect(pendingCalls).toHaveLength(1)
      expect(pendingCalls[0].url).toBe('/reports/daily')
      expect(pendingCalls[0].signal.aborted).toBe(false)

      // Rapid keyboard navigation: ArrowRight (weekly) -> End (monthly) -> Home (daily) -> ArrowLeft (monthly)
      await act(async () => {
        triggerTablistKey(renderer.root, 'ArrowRight')
      })
      expect(pendingCalls[0].signal.aborted).toBe(true)
      expect(pendingCalls[1].url).toBe('/reports/weekly')
      expect(pendingCalls[1].signal.aborted).toBe(false)

      await act(async () => {
        triggerTablistKey(renderer.root, 'End')
      })
      expect(pendingCalls[1].signal.aborted).toBe(true)
      expect(pendingCalls[2].url).toBe('/reports/monthly')

      await act(async () => {
        triggerTablistKey(renderer.root, 'Home')
      })
      expect(pendingCalls[2].signal.aborted).toBe(true)
      expect(pendingCalls[3].url).toBe('/reports/daily')

      await act(async () => {
        triggerTablistKey(renderer.root, 'ArrowLeft')
      })
      expect(pendingCalls[3].signal.aborted).toBe(true)
      expect(pendingCalls[4].url).toBe('/reports/monthly')
      expect(pendingCalls[4].signal.aborted).toBe(false)

      // Canceled rejections and stale out-of-order resolutions do not show error toasts or overwrite state
      await act(async () => {
        pendingCalls[0].reject({ name: 'CanceledError', code: 'ERR_CANCELED' })
        pendingCalls[1].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        pendingCalls[2].resolve({
          data: [{ id: 999, report_type: 'monthly', total_sales: 9999 }],
          headers: { 'x-has-more': 'false' },
        })
        pendingCalls[3].resolve({
          data: [{ id: 888, report_type: 'daily', total_sales: 8888 }],
          headers: { 'x-has-more': 'false' },
        })
        await flushPromises()
      })

      expect(mockToast).not.toHaveBeenCalled()
      expect(renderer.root.findByType('ul').findAllByType('li')).toHaveLength(0)

      // Final in-flight Monthly request resolves cleanly
      await act(async () => {
        pendingCalls[4].resolve({
          data: [{ id: 501, report_type: 'monthly', total_sales: 3600 }],
          headers: { 'x-has-more': 'false' },
        })
        await flushPromises()
      })

      expect(mockToast).not.toHaveBeenCalled()
      expect(pendingCalls[4].signal.aborted).toBe(false)
      const items = renderer.root.findByType('ul').findAllByType('li')
      expect(items).toHaveLength(1)
      expect(getTextContent(items[0])).toBe('MONTHLY — $3600.00')

      renderer.unmount()
    })

    test('issues zero requests when unauthenticated', async () => {
      currentAuthUser = null

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<Reports />)
        await flushPromises()
      })

      expect(renderer.toJSON()).toBeNull()
      expect(mockApi.get).not.toHaveBeenCalled()

      renderer.unmount()
    })
  })
})
