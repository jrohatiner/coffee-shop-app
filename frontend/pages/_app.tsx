'use client'
import '../styles/globals.css'
import type { NextPage } from 'next'
import type { AppProps } from 'next/app'
import Head from 'next/head'
import { Toaster } from '../components/ui/toaster'
import Navbar from '../components/Navbar'
import { useRouter } from 'next/router'

export type PageWithTitle<P = {}, IP = P> = NextPage<P, IP> & {
  pageTitle?: string
}

type AppPropsWithTitle = AppProps & {
  Component: PageWithTitle
}

export const ROUTE_TITLES: Record<string, string> = {
  '/': 'Coffee Shop Admin',
  '/login': 'Login - Coffee Shop Admin',
  '/dashboard': 'Dashboard - Coffee Shop Admin',
  '/orders': 'Orders - Coffee Shop Admin',
  '/inventory': 'Inventory - Coffee Shop Admin',
  '/reports': 'Sales Reports - Coffee Shop Admin',
  '/users': 'User Management - Coffee Shop Admin',
}

export default function App({ Component, pageProps }: AppPropsWithTitle) {
  const router = useRouter()
  const hideNav = router.pathname === '/login'
  const pageTitle =
    Component.pageTitle || ROUTE_TITLES[router.pathname] || 'Coffee Shop Admin'

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      {!hideNav && (
        <a
          href="#main-content"
          onClick={() => document.getElementById('main-content')?.focus()}
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-blue-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-900 focus:ring-offset-2"
        >
          Skip to main content
        </a>
      )}
      {!hideNav && <Navbar />}
      <main id="main-content" tabIndex={-1} className={hideNav ? '' : 'p-6'}>
        <Component {...pageProps} />
      </main>
      <Toaster />
    </>
  )
}
