import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { AuthLayout, AuthLogo } from './auth-shared'

/**
 * Landing point for the OAuth redirect: the Dashboard API bounces the browser
 * here with `#token=…` (or `#error=…` on the login page) once the provider has
 * confirmed the identity.
 *
 * The fragment is read once, at module scope, and stripped from the URL
 * immediately — a session token must not survive in history, the back button
 * or a bookmark. Memoising it here rather than in a ref or effect is what
 * makes that safe under StrictMode's double-invoked effects: the second pass
 * sees the same captured value instead of an already-cleared hash.
 */
let captured: URLSearchParams | null = null

function consumeFragment(): URLSearchParams {
  if (!captured) {
    captured = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  return captured
}

const MESSAGES: Record<string, string> = {
  access_denied: 'Sign-in was cancelled.',
  invalid_state: 'That sign-in link expired. Please try again.',
  provider_rejected: 'Your provider did not confirm a verified email address.',
}

export default function AuthCallback() {
  const adoptSession = useAuthStore((s) => s.adoptSession)
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const params = consumeFragment()
    const token = params.get('token')
    const error = params.get('error')

    if (!token) {
      setFailed(true)
      toast.error(MESSAGES[error ?? ''] ?? 'Sign-in failed. Please try again.')
      navigate('/login', { replace: true })
      return
    }

    adoptSession(token)
      .then(() => navigate('/', { replace: true }))
      .catch(() => {
        setFailed(true)
        toast.error('Sign-in failed. Please try again.')
        navigate('/login', { replace: true })
      })
  }, [adoptSession, navigate])

  return (
    <AuthLayout>
      <div className="flex flex-col items-center text-center">
        <AuthLogo />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {!failed && <Loader2 className="size-4 animate-spin" />}
          {failed ? 'Returning to sign-in…' : 'Signing you in…'}
        </div>
      </div>
    </AuthLayout>
  )
}
