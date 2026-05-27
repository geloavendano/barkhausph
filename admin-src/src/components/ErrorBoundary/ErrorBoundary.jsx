import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(err) {
    return { error: err }
  }

  componentDidCatch(err, info) {
    console.error('ErrorBoundary caught:', err, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 12,
          background: '#0e1117', color: '#e6e6e6', padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Something went wrong</div>
          <div style={{
            fontSize: 12, color: '#ff6b6b', background: 'rgba(255,100,100,0.1)',
            border: '0.5px solid rgba(255,100,100,0.3)', borderRadius: 8,
            padding: '10px 16px', maxWidth: 480, wordBreak: 'break-all',
            fontFamily: 'monospace',
          }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8, padding: '9px 24px', borderRadius: 50, border: 'none',
              background: '#FFCE58', color: '#3d2e00', fontWeight: 700,
              cursor: 'pointer', fontSize: 13,
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
