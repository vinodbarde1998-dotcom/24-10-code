import { useState, useEffect } from 'react';
import { Menu, X, Loader2 } from 'lucide-react';
import { AppProvider } from '@/context/AppContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import AuthScreen from '@/components/AuthScreen';
import RiskDisclaimerModal from '@/components/RiskDisclaimerModal';
import TopNav from '@/components/TopNav';
import Sidebar, { type ViewId } from '@/components/Sidebar';
import Footer from '@/components/Footer';
import PanicModal from '@/components/PanicModal';
import AdminApp from '@/components/admin/AdminApp';
import DashboardView from '@/views/DashboardView';
import AISmartBotView from '@/views/AISmartBotView';
import TradingStatusView from '@/views/TradingStatusView';
import SignalsView from '@/views/SignalsView';
import CryptoView from '@/views/CryptoView';
import CopyTradingView from '@/views/CopyTradingView';
import TradeHistoryView from '@/views/TradeHistoryView';
import PerformanceAnalyticsView from '@/views/PerformanceAnalyticsView';
import WalletView from '@/views/WalletView';
import MySubscriptionView from '@/views/MySubscriptionView';
import ConnectBrokerView from '@/views/ConnectBrokerView';
import BrokerResponseView from '@/views/BrokerResponseView';
import TutorialsView from '@/views/TutorialsView';
import FAQView from '@/views/FAQView';
import HelpCenterView from '@/views/HelpCenterView';
import ReportBugView from '@/views/ReportBugView';
import RealtimeToast from '@/components/RealtimeToast';
import { supabase } from '@/lib/supabase';

function isAdminRoute() {
  return window.location.hash === '#admin' || window.location.pathname === '/admin';
}

const viewTitles: Record<ViewId, string> = {
  'dashboard': 'Dashboard',
  'ai-smart-bot': 'AI Smart Bot',
  'trading-status': 'Trading Status',
  'signals': 'Signals',
  'crypto': 'Crypto',
  'copy-trading': 'Copy Trading Marketplace',
  'trade-history': 'Trade History',
  'performance-analytics': 'Performance Analytics',
  'wallet': 'Wallet & Calculation',
  'my-subscription': 'My Subscription',
  'connect-broker': 'Connect Your Broker',
  'broker-response': 'Broker Response',
  'tutorials': 'Tutorials & Guides',
  'faq': 'FAQ',
  'help-center': 'Help Center',
  'report-bug': 'Report Bug',
};

function AppContent() {
  const { session, profile, loading, refreshProfile } = useAuth();
  const [activeView, setActiveView] = useState<ViewId>('dashboard');
  const [panicOpen, setPanicOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panicLoading, setPanicLoading] = useState(false);

  const showDisclaimer = session?.user && (!profile || !profile.disclaimer_accepted);

  useEffect(() => {
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail as ViewId;
      if (detail) setActiveView(detail);
    };
    window.addEventListener('navigate', onNavigate);
    return () => window.removeEventListener('navigate', onNavigate);
  }, []);

  const handlePanicConfirm = async () => {
    setPanicLoading(true);
    try {
      await supabase.functions.invoke('trigger-panic-sell', {
        body: JSON.stringify({ mode: 'user' }),
      });
    } catch {
      // Even if the edge function fails, pause bots as a fallback
      const { error: pauseErr } = await supabase.from('bots').update({ status: 'paused' }).neq('status', 'paused');
      if (pauseErr) console.error('Panic fallback bot pause failed:', pauseErr.message);
    }
    setPanicLoading(false);
  };

  const renderView = () => {
    switch (activeView) {
      case 'dashboard': return <DashboardView />;
      case 'ai-smart-bot': return <AISmartBotView />;
      case 'trading-status': return <TradingStatusView />;
      case 'signals': return <SignalsView />;
      case 'crypto': return <CryptoView />;
      case 'copy-trading': return <CopyTradingView />;
      case 'trade-history': return <TradeHistoryView />;
      case 'performance-analytics': return <PerformanceAnalyticsView />;
      case 'wallet': return <WalletView />;
      case 'my-subscription': return <MySubscriptionView />;
      case 'connect-broker': return <ConnectBrokerView />;
      case 'broker-response': return <BrokerResponseView />;
      case 'tutorials': return <TutorialsView />;
      case 'faq': return <FAQView />;
      case 'help-center': return <HelpCenterView />;
      case 'report-bug': return <ReportBugView />;
      default: return <DashboardView />;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-neon-cyan animate-spin" />
          <p className="text-sm text-slate-400">Loading Cortex AI...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      {showDisclaimer && (
        <RiskDisclaimerModal onProceed={async () => { await refreshProfile(); }} />
      )}

      <TopNav onPanic={() => setPanicOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-64 flex-shrink-0 border-r border-white/[0.06] bg-base-850/50 backdrop-blur-sm">
          <Sidebar active={activeView} onSelect={setActiveView} />
        </aside>

        {/* Mobile sidebar */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-[90] flex">
            <div className="absolute inset-0 bg-base-900/70 backdrop-blur-md" onClick={() => setSidebarOpen(false)} />
            <div className="relative w-64 h-full bg-base-850 border-r border-white/[0.06] animate-slide-up">
              <button
                onClick={() => setSidebarOpen(false)}
                className="absolute top-3 right-3 z-10 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
              <Sidebar active={activeView} onSelect={setActiveView} onClose={() => setSidebarOpen(false)} />
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Mobile header */}
          <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-base-850/50 backdrop-blur-sm sticky top-0 z-30">
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors"
            >
              <Menu className="w-5 h-5" />
              Menu
            </button>
            <span className="text-sm font-semibold text-white">{viewTitles[activeView]}</span>
          </div>

          <div className="p-4 sm:p-6 max-w-7xl mx-auto">
            {/* Desktop breadcrumb */}
            <div className="hidden lg:flex items-center gap-2 mb-5 text-xs">
              <span className="text-slate-500">Cortex AI</span>
              <span className="text-slate-700">/</span>
              <span className="text-neon-cyan font-semibold">{viewTitles[activeView]}</span>
            </div>
            {renderView()}
          </div>
          <Footer />
        </main>
      </div>

      <PanicModal open={panicOpen} onClose={() => setPanicOpen(false)} onConfirm={handlePanicConfirm} />
      <RealtimeToast />
    </div>
  );
}

function AppRouter() {
  const { impersonating } = useAuth();
  const [adminRoute, setAdminRoute] = useState(isAdminRoute());

  useEffect(() => {
    const onHashChange = () => setAdminRoute(isAdminRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // When admin impersonates a user, switch to the user panel regardless of route
  const showAdmin = adminRoute && !impersonating;

  return showAdmin ? <AdminApp /> : <AppContent />;
}

function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <AppRouter />
      </AppProvider>
    </AuthProvider>
  );
}

export default App;
