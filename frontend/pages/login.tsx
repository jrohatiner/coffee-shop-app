'use client'
import { useState } from 'react'
import { useRouter } from 'next/router'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'

export default function Login(){
  const r = useRouter()
  const [username,setU]=useState(''); const [password,setP]=useState('')
  const submit = async ()=>{
    try{
      const form = new URLSearchParams({username,password})
      const res = await api.post('/auth/token', form, { headers: {'Content-Type':'application/x-www-form-urlencoded'} })
      localStorage.setItem('token', res.data.access_token)
      r.push('/dashboard')
    }catch(e){ toast({ title:'Login failed', description:'Invalid credentials', variant:'destructive'}) }
  }
  return (
    <main className="p-6 max-w-md mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Login</h1>
      <Input placeholder="Username" value={username} onChange={e=>setU((e.target as HTMLInputElement).value)} />
      <Input placeholder="Password" type="password" value={password} onChange={e=>setP((e.target as HTMLInputElement).value)} />
      <Button onClick={submit}>Sign in</Button>
    </main>
  )
}
