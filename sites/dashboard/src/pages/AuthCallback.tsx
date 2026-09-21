import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { AuthLayout, AuthLogo, consumeFragment, reportOAuthError } from './auth-shared'

/**
 * Landing point for a successful OAuth redirect: the Dashboard API bounces the
 * browser here with `#token=…` once the provider has confirmed the identity. A
 * refused sign-in goes to /login with `#error=…` instead, which Login reads
 * with the same helpers — see consumeFragment in auth-shared.
 */
export default function AuthCallback() {
  const adoptSession = useAuthStore((s) => s.adoptSession)
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const token = consumeFragment().get('token')

    if (!token) {
      setFailed(true)
      reportOAuthError()
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
