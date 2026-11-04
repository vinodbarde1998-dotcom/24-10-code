import {
  LayoutDashboard, Bot, Activity, Radio, Bitcoin,
  History, Wallet, Plug, Server, BookOpen,
  HelpCircle, LifeBuoy, Bug, ChevronRight, ShieldCheck, Copy, KeyRound, BarChart3,
} from 'lucide-react';

export type ViewId =
  | 'dashboard' | 'ai-smart-bot' | 'trading-status' | 'signals' | 'crypto'
  | 'copy-trading' | 'trade-history' | 'performance-analytics' | 'wallet' | 'connect-broker' | 'broker-response'
  | 'my-subscription' | 'tutorials' | 'faq' | 'help-center' | 'report-bug';

interface NavItem {
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    title: 'CORE TRADING & AI',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'ai-smart-bot', label: 'AI Smart Bot', icon: Bot, badge: 'NEW' },
      { id: 'trading-status', label: 'Trading Status', icon: Activity },
      { id: 'signals', label: 'Signals', icon: Radio },
      { id: 'crypto', label: 'Crypto', icon: Bitcoin },
      { id: 'copy-trading', label: 'Copy Trading Marketplace', icon: Copy, badge: 'NEW' },
    ],
  },
  {
    title: 'LOGS & CAPITAL',
    items: [
      { id: 'trade-history', label: 'Trade History', icon: History },
      { id: 'performance-analytics', label: 'Performance Analytics', icon: BarChart3, badge: 'NEW' },
      { id: 'wallet', label: 'Wallet & Calculation', icon: Wallet },
      { id: 'my-subscription', label: 'My Subscription', icon: KeyRound, badge: 'NEW' },
    ],
  },
  {
    title: 'SYSTEM & BROKER',
    items: [
      { id: 'connect-broker', label: 'Connect Your Broker', icon: Plug },
      { id: 'broker-response', label: 'Broker Response', icon: Server },
    ],
  },
  {
    title: 'SUPPORT',
    items: [
      { id: 'tutorials', label: 'Tutorials & Guides', icon: BookOpen },
      { id: 'faq', label: 'FAQ', icon: HelpCircle },
      { id: 'help-center', label: 'Help Center', icon: LifeBuoy },
      { id: 'report-bug', label: 'Report Bug', icon: Bug },
    ],
  },
];

interface Props {
  active: ViewId;
  onSelect: (id: ViewId) => void;
  onClose?: () => void;
}

export default function Sidebar({ active, onSelect, onClose }: Props) {
  return (
    <nav className="h-full flex flex-col py-4 px-3 overflow-y-auto scrollbar-thin">
      {groups.map((group) => (
        <div key={group.title} className="mb-5">
          <p className="px-3 mb-2 text-[10px] font-bold tracking-wider text-slate-500 uppercase">
            {group.title}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => {
              const isActive = active === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item.id);
                    onClose?.();
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group relative ${
                    isActive
                      ? 'bg-gradient-to-r from-neon-cyan/10 to-transparent text-white border border-neon-cyan/20'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r-full bg-neon-cyan neon-glow-cyan" />
                  )}
                  <Icon className={`w-[18px] h-[18px] flex-shrink-0 transition-colors ${isActive ? 'text-neon-cyan' : 'text-slate-500 group-hover:text-slate-300'}`} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.badge && (
                    <span className="px-1.5 py-0.5 rounded-md bg-neon-green/15 text-neon-green text-[9px] font-bold tracking-wide neon-glow-green">
                      {item.badge}
                    </span>
                  )}
                  {isActive && <ChevronRight className="w-4 h-4 text-neon-cyan/50" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Admin link + version */}
      <div className="mt-auto px-3 pt-4 border-t border-white/[0.04] space-y-2">
        <button
          onClick={() => { window.location.hash = 'admin'; }}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold text-neon-amber/80 hover:text-neon-amber bg-neon-amber/5 hover:bg-neon-amber/10 border border-neon-amber/15 transition-all"
        >
          <ShieldCheck className="w-4 h-4" />
          Master Admin Panel
          <ChevronRight className="w-3.5 h-3.5 ml-auto" />
        </button>
        <p className="text-[10px] text-slate-600">Cortex AI v3.2.1</p>
        <p className="text-[10px] text-slate-700">Neural Engine: Online</p>
      </div>
    </nav>
  );
}
