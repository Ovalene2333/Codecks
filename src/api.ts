import type { Snapshot } from './types'

let token = localStorage.getItem('codex-deck-token') || ''
export const getToken = () => token
export const setToken = (next: string) => { token = next; localStorage.setItem('codex-deck-token', next) }

export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data
}

export const getSnapshot = () => api<Snapshot>('/snapshot')
export const post = <T = any>(url: string, body?: any) => api<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const remove = <T = any>(url: string) => api<T>(url, { method: 'DELETE' })
