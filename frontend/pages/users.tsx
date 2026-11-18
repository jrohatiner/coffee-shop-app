'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useState } from 'react'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'

export type UserItem = { id: number; username: string; is_manager?: boolean }

export const CreateUserForm = memo(function CreateUserForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const [form, setForm] = useState({ username: '', password: '', is_manager: false })

  const create = async () => {
    try {
      await api.post('/users', form)
      toast({ title: 'User created', description: form.username })
      setForm({ username: '', password: '', is_manager: false })
      onCreated()
    } catch {
      toast({ title: 'Error', description: 'Failed to create', variant: 'destructive' })
    }
  }

  return (
    <div className="border rounded p-4 space-y-2">
      <h2 className="font-semibold">Create</h2>
      <Input
        placeholder="Username"
        value={form.username}
        onChange={e =>
          setForm(prev => ({ ...prev, username: (e.target as HTMLInputElement).value }))
        }
      />
      <Input
        placeholder="Password"
        type="password"
        value={form.password}
        onChange={e =>
          setForm(prev => ({ ...prev, password: (e.target as HTMLInputElement).value }))
        }
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.is_manager}
          onChange={e =>
            setForm(prev => ({ ...prev, is_manager: (e.target as HTMLInputElement).checked }))
          }
        />
        <span>Manager</span>
      </label>
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
      <Button onClick={() => onDelete(user.id)}>Delete</Button>
    </li>
  )
})

export default function Users() {
  const user = useAuth()
  const [users, setUsers] = useState<UserItem[]>([])

  const load = useCallback(() => {
    api
      .get('/users')
      .then(r => setUsers(r.data))
      .catch(() => toast({ title: 'Error', description: 'Manager only', variant: 'destructive' }))
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
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <CreateUserForm onCreated={load} />
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Existing</h2>
        <ul className="space-y-2">
          {users.map(u => (
            <UserRow key={u.id} user={u} onDelete={del} />
          ))}
        </ul>
      </div>
    </main>
  )
}
