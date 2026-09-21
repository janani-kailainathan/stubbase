import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'
import { queryClient } from '@/lib/query'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Before <App />, and it has to stay there. React runs mount effects in
          tree order, so a page that toasts from its own mount effect — the
          login page reporting a refused OAuth sign-in — would fire before the
          Toaster had subscribed, and the toast would be dropped with nothing
          shown and no error anywhere. */}
      <Toaster />
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
