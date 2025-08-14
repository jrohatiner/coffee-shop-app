'use client'
import '../styles/globals.css'
import type { AppProps } from 'next/app'
import { Toaster } from '../components/ui/toaster'
import Navbar from '../components/Navbar'
import { useRouter } from 'next/router'

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()
  const hideNav = router.pathname === '/login'

  return (
    <>
      {!hideNav && <Navbar />}
      <main className={hideNav ? '' : 'p-6'}>
        <Component {...pageProps} />
      </main>
      <Toaster />
    </>
  )
}
