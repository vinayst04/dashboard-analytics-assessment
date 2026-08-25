import type { Account, DashboardData, ExplorerData, FilterValues } from './types'

type ApiErrorBody = { detail?: unknown }

const apiErrorMessage = (detail: unknown, fallback: string) => {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) return 'Please check the information provided and try again.'
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown; error?: unknown }).message ?? (detail as { error?: unknown }).error
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

const apiFetch = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody
    throw new Error(apiErrorMessage(body.detail, 'Something went wrong while loading analytics.'))
  }
  return response.json() as Promise<T>
}

export const getFilters = () => apiFetch<FilterValues>('/api/filters')

export const getDashboard = (params: URLSearchParams) =>
  apiFetch<DashboardData>(`/api/dashboard?${params.toString()}`)

export const getExplorerData = (params: URLSearchParams) =>
  apiFetch<ExplorerData>(`/api/explore?${params.toString()}`)

export const getInsights = (params: URLSearchParams) =>
  apiFetch<{ insights: { title: string; explanation: string; action: string }[] }>(
    `/api/insights?${params.toString()}`,
  )

export const getCurrentAccount = () => apiFetch<Account>('/api/auth/me')

export const logout = async () => {
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  if (!response.ok) throw new Error('Unable to sign out.')
}

export const askGemini = async (question: string, params: URLSearchParams) => {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/insights/ask?${params.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      const body = (await response.json().catch(() => ({}))) as { answer?: unknown; detail?: unknown }
      if (!response.ok) throw new Error(apiErrorMessage(body.detail, 'Unable to answer this question.'))
      return typeof body.answer === 'string' && body.answer.trim()
        ? body.answer
        : 'I can answer questions about the current dashboard data, including revenue, orders, products, categories, outlets, channels, and payment methods.'
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unable to answer this question.')
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
  }
  throw lastError ?? new Error('Unable to answer this question.')
}

export type AiDashboardWidget = {
  title: string
  source: 'category' | 'outlet' | 'channel' | 'payment' | 'trend' | 'items'
  visual: 'bar' | 'horizontalBar' | 'line' | 'area' | 'pie' | 'donut' | 'table' | 'pivot'
  description: string
}

export type AiDashboardConfig = {
  title: string
  summary: string
  period: string
  generation_notice?: string
  widgets: AiDashboardWidget[]
  data: DashboardData
}

export const createAiDashboard = async (prompt: string) => {
  const response = await fetch('/api/ai-dashboard', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  const body = (await response.json().catch(() => ({}))) as AiDashboardConfig & ApiErrorBody
  if (!response.ok) throw new Error(apiErrorMessage(body.detail, 'Unable to create the AI dashboard.'))
  return body
}
