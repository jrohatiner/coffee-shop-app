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
jest.mock('../hooks/useAuth', () => ({
  useAuth: () => mockUser,
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

import Inventory, { ProductRow } from '../pages/inventory'
import Users, { UserRow } from '../pages/users'
import Orders, { OrderCreator, OrdersTable, ProductPickerRow } from '../pages/orders'

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

      const nameInput = renderer.root.findByProps({ placeholder: 'Name' })
      const priceInput = renderer.root.findByProps({ placeholder: 'Price' })
      const stockInput = renderer.root.findByProps({ placeholder: 'Stock' })

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

      expect(renderer.root.findByProps({ placeholder: 'Name' }).props.value).toBe('Flat White')
      expect(renderer.root.findByProps({ placeholder: 'Price' }).props.value).toBe(4.75)
      expect(renderer.root.findByProps({ placeholder: 'Stock' }).props.value).toBe(30)

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
      expect(renderer.root.findByProps({ placeholder: 'Name' }).props.value).toBe('')
      expect(renderer.root.findByProps({ placeholder: 'Price' }).props.value).toBe(0)
      expect(renderer.root.findByProps({ placeholder: 'Stock' }).props.value).toBe(0)

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
      expect(updatedFirstRowInputs[2].props.value).toBe(6)

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

      const usernameInput = renderer.root.findByProps({ placeholder: 'Username' })
      const passwordInput = renderer.root.findByProps({ placeholder: 'Password' })
      const managerCheckbox = renderer.root.findByProps({ type: 'checkbox' })

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

      expect(renderer.root.findByProps({ placeholder: 'Username' }).props.value).toBe('dave')
      expect(renderer.root.findByProps({ placeholder: 'Password' }).props.value).toBe('secret123')
      expect(renderer.root.findByProps({ type: 'checkbox' }).props.checked).toBe(true)

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
      expect(renderer.root.findByProps({ placeholder: 'Username' }).props.value).toBe('')
      expect(renderer.root.findByProps({ placeholder: 'Password' }).props.value).toBe('')
      expect(renderer.root.findByProps({ type: 'checkbox' }).props.checked).toBe(false)

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
      })

      expect(modalRenderSpy).toHaveBeenCalledTimes(1)
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
      mockApi.post.mockResolvedValue({ data: { id: 105 } })

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
        socketListeners['new_order']?.forEach(cb => cb())
        socketListeners['stock_update']?.forEach(cb => cb())
        await flushPromises()
      })
      // Echoes from our own local create were suppressed; subsequent remote event goes through
      expect(mockToast).not.toHaveBeenCalledWith({ title: 'New Order' })
      expect(mockApi.get).not.toHaveBeenCalled()

      await act(async () => {
        socketListeners['new_order']?.forEach(cb => cb())
        await flushPromises()
      })
      expect(mockToast).toHaveBeenCalledWith({ title: 'New Order' })
      expect(mockApi.get).toHaveBeenCalledWith('/orders', {
        params: { limit: 20, offset: 0, status: 'pending' },
      })

      renderer.unmount()
    })
  })
})
