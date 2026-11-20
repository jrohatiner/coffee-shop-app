'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useId, useState } from 'react'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import FormErrorBanner from '../components/ui/FormErrorBanner'
import { toast } from '../components/ui/use-toast'

export type UserItem = { id: number; username: string; is_manager?: boolean }

export const CreateUserForm = memo(function CreateUserForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const managerCheckboxId = useId()
  const [form, setForm] = useState({ username: '', password: '', is_manager: false })
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const [createError, setCreateError] = useState<string | null>(null)

  const create = async () => {
    setCreateError(null)
    const missingUsername = !form.username.trim()
    const missingPassword = !form.password.trim()
    if (missingUsername || missingPassword) {
      setErrors({
        username: missingUsername ? 'Username is required.' : undefined,
        password: missingPassword ? 'Password is required.' : undefined,
      })
      toast({
        title: 'Error',
        description: 'Username and password are required',
        variant: 'destructive',
      })
      return
    }

    setErrors({})
    try {
      await api.post('/users', form)
      setCreateError(null)
      toast({ title: 'User created', description: form.username })
      setForm({ username: '', password: '', is_manager: false })
      onCreated()
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      setCreateError(
        typeof detail === 'string' && detail
          ? `Failed to create user: ${detail}`
          : 'Failed to create user.'
      )
      toast({ title: 'Error', description: 'Failed to create', variant: 'destructive' })
    }
  }

  return (
    <div className="border rounded p-4 space-y-3 max-w-lg">
      <h2 className="font-semibold">Create</h2>
      <Input
        label="Username"
        name="username"
        autoComplete="off"
        value={form.username}
        error={errors.username}
        aria-invalid={Boolean(errors.username || createError) || undefined}
        aria-describedby={createError ? 'users-create-error' : undefined}
        onChange={e => {
          const val = (e.target as HTMLInputElement).value
          setForm(prev => ({ ...prev, username: val }))
          if (val.trim()) {
            setErrors(prev => (prev.username ? { ...prev, username: undefined } : prev))
          }
        }}
      />
      <Input
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        value={form.password}
        error={errors.password}
        aria-invalid={Boolean(errors.password || createError) || undefined}
        aria-describedby={createError ? 'users-create-error' : undefined}
        onChange={e => {
          const val = (e.target as HTMLInputElement).value
          setForm(prev => ({ ...prev, password: val }))
          if (val.trim()) {
            setErrors(prev => (prev.password ? { ...prev, password: undefined } : prev))
          }
        }}
      />
      <label
        htmlFor={managerCheckboxId}
        className="flex items-center gap-2 text-sm font-medium text-gray-800"
      >
        <input
          id={managerCheckboxId}
          type="checkbox"
          checked={form.is_manager}
          onChange={e =>
            setForm(prev => ({ ...prev, is_manager: (e.target as HTMLInputElement).checked }))
          }
        />
        <span>Manager</span>
      </label>
      <FormErrorBanner id="users-create-error" message={createError} />
      <Button onClick={create}>Create User</Button>
    </div>
  )
})

export const UserRow = memo(function UserRow({
  user,
  onDelete,
}: {
  user: UserItem
  onDelete: (id: number) => void
}) {
  return (
    <li className="flex justify-between items-center">
      <span>
        {user.username} {user.is_manager ? '(Manager)' : ''}
      </span>
      <Button contextLabel={`user ${user.username}`} onClick={() => onDelete(user.id)}>
        Delete
      </Button>
    </li>
  )
})

export default function Users() {
  const user = useAuth()
  const [users, setUsers] = useState<UserItem[]>([])
  const [accessError, setAccessError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .get('/users')
      .then(r => {
        setUsers(r.data)
        setAccessError(prev => (prev ? null : prev))
      })
      .catch(() => {
        setAccessError('Manager permissions are required to view and manage users.')
        toast({ title: 'Error', description: 'Manager only', variant: 'destructive' })
      })
  }, [])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  const del = useCallback(
    async (id: number) => {
      try {
        await api.delete(`/users/${id}`)
        toast({ title: 'User deleted' })
        load()
      } catch {
        toast({ title: 'Error', description: 'Failed to delete', variant: 'destructive' })
      }
    },
    [load]
  )

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <FormErrorBanner id="users-access-error" message={accessError} />
      <CreateUserForm onCreated={load} />
      <div className="border rounded p-4 space-y-2">
        <h2 id="existing-users-heading" className="font-semibold">
          Existing
        </h2>
        <ul aria-labelledby="existing-users-heading" className="space-y-2">
          {users.map(u => (
            <UserRow key={u.id} user={u} onDelete={del} />
          ))}
        </ul>
      </div>
    </div>
  )
}
