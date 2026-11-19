'use client'
import React, { useState } from 'react'
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
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const submit = async ()=>{
  const submit = async (e?: React.FormEvent)=>{
    e?.preventDefault()
    try{
      const form = new URLSearchParams({username,password})
      const res = await api.post('/auth/token', form, { headers: {'Content-Type':'application/x-www-form-urlencoded'} })
      setErrors({})
      localStorage.setItem('token', res.data.access_token)
      r.push('/dashboard')
    }catch(e){
      setFormError('Login failed: Invalid credentials. Check your username and password and try again.')
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
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={e=>setU((e.target as HTMLInputElement).value)}
        />
        <Input
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e=>setP((e.target as HTMLInputElement).value)}
        />
        <Button type="submit">Sign in</Button>
      </form>
    </div>
  )
}
