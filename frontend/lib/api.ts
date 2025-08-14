import axios from 'axios'
const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000' })

api.interceptors.request.use((cfg)=>{
  if(typeof window !== 'undefined'){
    const token = localStorage.getItem('token')
    if(token && cfg.headers) cfg.headers.Authorization = `Bearer ${token}`
  }
  return cfg
})
export default api
