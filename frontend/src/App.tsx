import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import LoginScreen from './components/LoginScreen';
import { useChat } from './hooks/useChat';

import ScoutPage from './components/ScoutPage';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const chatState = useChat();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        if (data.connected) {
          setIsAuthenticated(true);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setCheckingAuth(false);
      }
    };
    checkAuth();
  }, []);

  if (checkingAuth) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  if (!isAuthenticated) {
    return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <Router>
      <ResponsiveShell chatState={chatState} />
    </Router>
  );
}

// ── Responsive shell ─────────────────────────────────────────────────────────
// Mobile (<md): single-column. Sidebar visible by default; opening a chat hides it.
// Desktop (≥md): two-column layout with sidebar always visible.
function ResponsiveShell({ chatState }: { chatState: ReturnType<typeof useChat> }) {
  const hasOpenChat = !!chatState.currentDialogue;

  return (
    <div className="flex h-[100dvh] bg-background text-foreground overflow-hidden font-sans">
      {/* Sidebar — full-width on mobile when no chat open, fixed 320px on md+ */}
      <aside
        className={`${hasOpenChat ? 'hidden md:flex' : 'flex'} w-full md:w-80 border-r border-border flex-col shrink-0`}
      >
        <Sidebar chatState={chatState} />
      </aside>

      {/* Main pane */}
      <main className={`${hasOpenChat ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-muted/20 relative min-w-0`}>
        <Routes>
          <Route path="/" element={<ChatWindow dialogue={chatState.currentDialogue} actions={chatState} />} />
          <Route path="/scout" element={<ScoutPage />} />
          <Route path="/scout/:username" element={<ScoutPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
