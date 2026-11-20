'use client'
import { useAuth } from '../hooks/useAuth'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'
import { useFocusHandoff } from '../hooks/useFocusHandoff'
import type { UserOut } from '../types/api'

export type UserItem = UserOut

export const CreateUserForm = memo(function CreateUserForm({
  onCreated,
}: {
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    username: '',
    password: '',
    is_manager: false,
  })

  const create = async () => {
    try {
      await api.post('/users', form)
      toast({ title: 'User created', description: form.username })
      setForm({ username: '', password: '', is_manager: false })
      onCreated()
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to create',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="border rounded p-4 space-y-3">
      <h2 className="font-semibold">Create</h2>
      <Input
        label="Username"
        value={form.username}
        onChange={(e) =>
          setForm((prev) => ({
            ...prev,
            username: (e.target as HTMLInputElement).value,
          }))
        }
      />
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        value={form.password}
        onChange={(e) =>
          setForm((prev) => ({
            ...prev,
            password: (e.target as HTMLInputElement).value,
          }))
        }
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.is_manager}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              is_manager: (e.target as HTMLInputElement).checked,
            }))
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
  onRegisterDeleteButton,
}: {
  user: UserItem
  onDelete: (id: number) => void
  onRegisterDeleteButton?: (id: number, el: HTMLButtonElement | null) => void
}) {
  const setDeleteButtonRef = useCallback(
    (el: HTMLButtonElement | null) => {
      onRegisterDeleteButton?.(user.id, el)
    },
    [onRegisterDeleteButton, user.id]
  )

  return (
    <li className="flex justify-between items-center">
      <span>
        {user.username} {user.is_manager ? '(Manager)' : ''}
      </span>
      <Button
        ref={setDeleteButtonRef}
        contextLabel={`user ${user.username}`}
        onClick={() => onDelete(user.id)}
      >
        Delete
      </Button>
    </li>
  )
})

export default function Users() {
  const user = useAuth()
  const [users, setUsers] = useState<UserItem[]>([])
  const usersRef = useRef<UserItem[]>(users)
  usersRef.current = users
  const existingUsersHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const deleteButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const { prepareFocusHandoff } = useFocusHandoff()

  const registerDeleteButton = useCallback(
    (id: number, el: HTMLButtonElement | null) => {
      if (el) {
        deleteButtonRefs.current.set(id, el)
      } else {
        deleteButtonRefs.current.delete(id)
      }
    },
    []
  )

  const load = useCallback(() => {
    return api
      .get('/users')
      .then((r) => {
        usersRef.current = r.data
        setUsers(r.data)
      })
      .catch(() =>
        toast({
          title: 'Error',
          description: 'Manager only',
          variant: 'destructive',
        })
      )
  }, [])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  const del = useCallback(
    async (id: number) => {
      const snapshot = usersRef.current
      const deletedIdx = snapshot.findIndex((u) => u.id === id)
      const nextNeighborId =
        deletedIdx >= 0 ? snapshot[deletedIdx + 1]?.id : undefined
      const prevNeighborId =
        deletedIdx > 0 ? snapshot[deletedIdx - 1]?.id : undefined

      const handoff = prepareFocusHandoff(
        deleteButtonRefs.current.get(id),
        () => {
          const currentUsers = usersRef.current
          const candidates: (HTMLElement | string | null | undefined)[] = []
          if (nextNeighborId !== undefined) {
            candidates.push(deleteButtonRefs.current.get(nextNeighborId))
          }
          if (deletedIdx >= 0 && currentUsers.length > 0) {
            const adjacentUser =
              currentUsers[Math.min(deletedIdx, currentUsers.length - 1)]
            if (adjacentUser) {
              candidates.push(deleteButtonRefs.current.get(adjacentUser.id))
            }
          }
          if (prevNeighborId !== undefined) {
            candidates.push(deleteButtonRefs.current.get(prevNeighborId))
          }
          candidates.push(
            existingUsersHeadingRef.current,
            '#existing-users-heading'
          )
          return candidates
        }
      )

      try {
        await api.delete(`/users/${id}`)
        toast({ title: 'User deleted' })
        await load()
        handoff.commit()
      } catch {
        handoff.cancel()
        toast({
          title: 'Error',
          description: 'Failed to delete',
          variant: 'destructive',
        })
      }
    },
    [load, prepareFocusHandoff]
  )

  if (!user) return null

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <CreateUserForm onCreated={load} />
      <div className="border rounded p-4 space-y-2">
        <h2
          id="existing-users-heading"
          ref={existingUsersHeadingRef}
          tabIndex={-1}
          className="font-semibold"
        >
          Existing
        </h2>
        <ul aria-labelledby="existing-users-heading" className="space-y-2">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              onDelete={del}
              onRegisterDeleteButton={registerDeleteButton}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}
