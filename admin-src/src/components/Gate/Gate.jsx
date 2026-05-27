import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import styles from './Gate.module.css'

export default function Gate() {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function handleSignIn() {
    setLoading(true)
    setError('')
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/admin/`,
        },
      })
      if (err) throw err
      // Page redirects to Google — execution stops here
    } catch (err) {
      setError(err.message || 'Sign in failed. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.logo}>
          BARK<span>🐾</span>US
        </div>
        <p className={styles.sub}>Admin Portal</p>

        <button
          className={styles.btn}
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? 'Redirecting…' : 'Sign in with Google'}
        </button>

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  )
}
