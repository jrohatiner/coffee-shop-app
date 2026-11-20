'use client'
import React, { useState } from 'react'
import { useRouter } from 'next/router'
import api from '../lib/api'
import { setAuthToken } from '../hooks/useAuth'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { toast } from '../components/ui/use-toast'
import type { Token } from '../types/api'

export default function Login() {
  const r = useRouter()
  const [username, setU] = useState('')
  const [password, setP] = useState('')
  const [errors, setErrors] = useState<{
    username?: string
    password?: string
  }>({})
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setFormError(null)
    try {
      const form = new URLSearchParams({ username, password })
      const res = await api.post<Token>('/auth/token', form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      setErrors({})
      setAuthToken(res.data.access_token)
      r.push('/dashboard')
    } catch {
      const missingUsername = !username.trim()
      const missingPassword = !password.trim()
      if (missingUsername || missingPassword) {
        setErrors({
          username: missingUsername ? 'Username is required.' : undefined,
          password: missingPassword ? 'Password is required.' : undefined,
        })
        return
      }
      setErrors({})
      setFormError(
        'Login failed: Invalid credentials. Check your username and password and try again.'
      )
      toast({
        title: 'Login failed',
        description: 'Invalid credentials',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Login</h1>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Input
          id="login-username"
          label="Username"
          name="username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          error={errors.username}
          aria-invalid={Boolean(errors.username || formError) || undefined}
          aria-describedby={formError ? 'login-form-error' : undefined}
          onChange={(e) => {
            const val = (e.target as HTMLInputElement).value
            setU(val)
            if (val.trim()) {
              setErrors((prev) =>
                prev.username ? { ...prev, username: undefined } : prev
              )
            }
          }}
        />
        <Input
          id="login-password"
          label="Password"
          name="password"
          placeholder="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          error={errors.password}
          aria-invalid={Boolean(errors.password || formError) || undefined}
          aria-describedby={formError ? 'login-form-error' : undefined}
          onChange={(e) => {
            const val = (e.target as HTMLInputElement).value
            setP(val)
            if (val.trim()) {
              setErrors((prev) =>
                prev.password ? { ...prev, password: undefined } : prev
              )
            }
          }}
        />
        <FormErrorBanner id="login-form-error" message={formError} />
        <Button type="submit">Sign in</Button>
      </form>
    </div>
  )
}
