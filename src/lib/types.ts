export type FilterValues = {
  outlets: string[]
  groups: string[]
  order_types: string[]
  settlements: string[]
  date_range: { min: string; max: string }
}

export type DashboardData = {
  metrics: {
    revenue: number
    orders: number
    units: number
    average_order_value: number
  }
  revenue_trend: { date: string; revenue: number; orders: number }[]
  category_sales: { label: string; value: number; units: number }[]
  outlet_performance: { outlet: string; revenue: number; orders: number }[]
  order_type_mix: { label: string; value: number }[]
  payment_mix: { label: string; value: number }[]
  top_items: { item: string; revenue: number; units: number }[]
  applied_filters: Record<string, string | null>
}

export type ApiFailure = { detail?: string }

export type Account = {
  id: number
  email: string
  provider: 'google' | 'password'
}

export type ExplorerRow = {
  dimensions: Record<string, string>
  value: number
}

export type ExplorerData = {
  dimensions: { key: string; label: string }[]
  measure: { key: string; label: string }
  rows: ExplorerRow[]
  row_limit: number
}
