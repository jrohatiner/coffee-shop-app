'use client'
import { useState } from 'react'
import { useRouter } from 'next/router'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { toast } from '../components/ui/use-toast'

export default function Login(){
  const r = useRouter()
  const [username,setU]=useState(''); const [password,setP]=useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const submit = async ()=>{
    setFormError(null)
    try{
      const form = new URLSearchParams({username,password})
      const res = await api.post('/auth/token', form, { headers: {'Content-Type':'application/x-www-form-urlencoded'} })
      localStorage.setItem('token', res.data.access_token)
      r.push('/dashboard')
    }catch(e){
      setFormError('Login failed: Invalid credentials. Check your username and password and try again.')
      toast({ title:'Login failed', description:'Invalid credentials', variant:'destructive'})
    }
  }
  return (
    <div className="p-6 max-w-md mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Login</h1>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        noValidate
      >
        <div className="space-y-1">
          <label htmlFor="login-username" className="block text-sm font-medium text-gray-800">
            Username
          </label>
          <Input
            id="login-username"
            placeholder="Username"
            value={username}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? 'login-form-error' : undefined}
            onChange={e=>setU((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm font-medium text-gray-800">
            Password
          </label>
          <Input
            id="login-password"
            placeholder="Password"
            type="password"
            value={password}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? 'login-form-error' : undefined}
            onChange={e=>setP((e.target as HTMLInputElement).value)}
          />
        </div>
        <FormErrorBanner id="login-form-error" message={formError} />
        <Button type="submit">Sign in</Button>
      </form>
    </div>
  )
}
