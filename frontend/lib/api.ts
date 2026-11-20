import axios from 'axios'

const resolveApiBaseUrl = (): string => {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (configured) {
    return configured === '/' ? '' : configured.replace(/\/+$/, '')
  }
  return process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000'
}

const api = axios.create({ baseURL: resolveApiBaseUrl() })

api.interceptors.request.use((cfg)=>{
  if(typeof window !== 'undefined'){
    const token = localStorage.getItem('token')
    if(token && cfg.headers) cfg.headers.Authorization = `Bearer ${token}`
  }
  return cfg
})
export default api
