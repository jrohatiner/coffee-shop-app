'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'

export default function Users(){
  const user = useAuth()
  const [users,setUsers]=useState<any[]>([])
  const [form,setForm]=useState({ username:'', password:'', is_manager:false })
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({})
  const [accessError, setAccessError] = useState('')
  const load=()=>api.get('/users').then(r=>{ setUsers(r.data); setAccessError('') }).catch(()=>{
    setAccessError('Manager permissions are required to view and manage users.')
    toast({title:'Error', description:'Manager only', variant:'destructive'})
  })
  useEffect(()=>{ if(user) load() },[user])
  if(!user) return null
  const create=async()=>{
    const missingUsername = !form.username.trim()
    const missingPassword = !form.password.trim()
    try{
      if (missingUsername || missingPassword) {
        setErrors({
          username: missingUsername ? 'Username is required.' : undefined,
          password: missingPassword ? 'Password is required.' : undefined,
        })
        throw new Error('Validation failed')
      }
      setErrors({})
      await api.post('/users', form)
      toast({title:'User created', description:form.username})
      setForm({username:'',password:'',is_manager:false})
      load()
    }
    catch(e: any){
      if (!missingUsername && !missingPassword) {
        const detail = e?.response?.data?.detail
        setErrors({
          username: typeof detail === 'string' ? detail : 'Failed to create user. Verify username and manager permissions.',
        })
      }
      toast({title:'Error', description:'Failed to create', variant:'destructive'})
    }
  }
  const del=async(id:number)=>{
    try{ await api.delete(`/users/${id}`); toast({title:'User deleted'}); load() }
    catch{ toast({title:'Error', description:'Failed to delete', variant:'destructive'}) }
  }
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      {accessError && (
        <p className="flex items-start gap-1.5 rounded border border-red-700 bg-red-50 p-3 text-sm font-medium text-red-900">
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-0.5 h-4 w-4 shrink-0 text-red-800"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          <span>{accessError}</span>
        </p>
      )}
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Create</h2>
        <Input
          label="Username"
          placeholder="Username"
          value={form.username}
          error={errors.username}
          onChange={e=>{
            const val = (e.target as HTMLInputElement).value
            setForm({...form, username: val})
            if (val.trim() && errors.username) setErrors(prev => ({ ...prev, username: undefined }))
          }}
        />
        <Input
          label="Password"
          placeholder="Password"
          type="password"
          value={form.password}
          error={errors.password}
          onChange={e=>{
            const val = (e.target as HTMLInputElement).value
            setForm({...form, password: val})
            if (val.trim() && errors.password) setErrors(prev => ({ ...prev, password: undefined }))
          }}
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.is_manager} onChange={e=>setForm({...form, is_manager:(e.target as HTMLInputElement).checked})}/>
          <span>Manager</span>
        </label>
        <Button onClick={create}>Create User</Button>
      </div>
      <div className="border rounded p-4 space-y-2">
        <h2 id="existing-users-heading" className="font-semibold">Existing</h2>
        <ul aria-labelledby="existing-users-heading" className="space-y-2">
          {users.map(u=>(
            <li key={u.id} className="flex justify-between items-center">
              <span>{u.username} {u.is_manager ? '(Manager)' : ''}</span>
              <Button contextLabel={`user ${u.username}`} onClick={()=>del(u.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
