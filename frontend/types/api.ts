import axios from 'axios'

export interface UserOut {
  id: number
  username: string
  is_manager?: boolean
}

export interface ProductOut {
  id: number
  name: string
  price: number
  stock: number
}

export interface StockDeltaOut {
  updated: ProductOut[]
  deleted_ids: number[]
}

export type OrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface OrderItemCreate {
  product_id: number
  quantity: number
}

export interface OrderCreate {
  status?: OrderStatus
  items: OrderItemCreate[]
}

export interface OrderItemOut {
  id: number
  product_id: number
  quantity: number
  product: ProductOut
}

export interface OrderSummaryOut {
  id: number
  status: string
  created_at: string
}

export interface OrderOut {
  id: number
  user_id?: number | null
  status: string
  created_at: string
  items: OrderItemOut[]
}

export interface SalesReportOut {
  id: number
  report_type: string
  total_sales: number
  created_at: string
}

export interface DashboardSummary {
  totalSales: number
  recentOrders?: OrderSummaryOut[]
}

export interface Token {
  access_token: string
  token_type: string
}

export interface ApiErrorPayload {
  detail?: string
}

export function getApiErrorDetail(error: unknown, fallback: string): string {
  if (axios.isAxiosError<ApiErrorPayload>(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail.length > 0) {
      return detail
    }
  }
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as { data?: unknown }).data
      if (data && typeof data === 'object' && 'detail' in data) {
        const detail = (data as { detail?: unknown }).detail
        if (typeof detail === 'string' && detail.length > 0) {
          return detail
        }
      }
    }
  }
  return fallback
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref()
  }
}
