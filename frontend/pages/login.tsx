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
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const submit = async ()=>{
    try{
      const form = new URLSearchParams({username,password})
      const res = await api.post('/auth/token', form, { headers: {'Content-Type':'application/x-www-form-urlencoded'} })
      setErrors({})
      localStorage.setItem('token', res.data.access_token)
      r.push('/dashboard')
    }catch(e){
      setErrors({
        username: !username.trim()
          ? 'Username is required.'
          : 'Invalid credentials. Check your username and try again.',
        password: !password.trim()
          ? 'Password is required.'
          : 'Invalid credentials. Check your password and try again.',
      })
      toast({ title:'Login failed', description:'Invalid credentials', variant:'destructive'})
    }
  }
  return (
    <div className="p-6 max-w-md mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Login</h1>
      <Input
        label="Username"
        placeholder="Username"
        value={username}
        error={errors.username}
        onChange={e=>{
          const val = (e.target as HTMLInputElement).value
          setU(val)
          if (errors.username) setErrors(prev => ({ ...prev, username: undefined }))
        }}
      />
      <Input
        label="Password"
        placeholder="Password"
        type="password"
        value={password}
        error={errors.password}
        onChange={e=>{
          const val = (e.target as HTMLInputElement).value
          setP(val)
          if (errors.password) setErrors(prev => ({ ...prev, password: undefined }))
        }}
      />
      <Button onClick={submit}>Sign in</Button>
    </div>
  )
}
