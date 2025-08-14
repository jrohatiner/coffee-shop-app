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
  const load=()=>api.get('/users').then(r=>setUsers(r.data)).catch(()=>toast({title:'Error', description:'Manager only', variant:'destructive'}))
  useEffect(()=>{ if(user) load() },[user])
  if(!user) return null
  const create=async()=>{
    try{ await api.post('/users', form); toast({title:'User created', description:form.username}); setForm({username:'',password:'',is_manager:false}); load() }
    catch{ toast({title:'Error', description:'Failed to create', variant:'destructive'}) }
  }
  const del=async(id:number)=>{
    try{ await api.delete(`/users/${id}`); toast({title:'User deleted'}); load() }
    catch{ toast({title:'Error', description:'Failed to delete', variant:'destructive'}) }
  }
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Create</h2>
        <Input placeholder="Username" value={form.username} onChange={e=>setForm({...form, username:(e.target as HTMLInputElement).value})}/>
        <Input placeholder="Password" type="password" value={form.password} onChange={e=>setForm({...form, password:(e.target as HTMLInputElement).value})}/>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.is_manager} onChange={e=>setForm({...form, is_manager:(e.target as HTMLInputElement).checked})}/>
          <span>Manager</span>
        </label>
        <Button onClick={create}>Create User</Button>
      </div>
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Existing</h2>
        <ul className="space-y-2">
          {users.map(u=>(
            <li key={u.id} className="flex justify-between items-center">
              <span>{u.username} {u.is_manager ? '(Manager)' : ''}</span>
              <Button onClick={()=>del(u.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
