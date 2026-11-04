import { useEffect, useState } from 'react';
import { History, ArrowUpRight, ArrowDownRight, Loader2, Trash2, CheckCircle2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { supabase, type Trade } from '@/lib/supabase';
import { SkeletonTable } from '@/components/Skeleton';

export default function TradeHistoryView() {
  const { formatInr } = useApp();
  const { session } = useAuth();
  const userId = session?.user?.id ?? '';
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let mounted = true;

    supabase
      .from('trades')
      .select('*')
      .eq('client_id', userId)
      .neq('status', 'open')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!mounted) return;
        setTrades((data as Trade[]) ?? []);
        setLoading(false);
      });

    const channel = supabase
      .channel('client-trade-history')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trades', filter: `client_id=eq.${userId}` },
        (payload) => {
          const newTrade = payload.new as Trade;
          setTrades((prev) => [newTrade, ...prev]);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trades', filter: `client_id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as Trade;
          setTrades((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        },
      )
      .subscribe();

    // ── Realtime: positions table (auto-close by 5s engine syncs to trades) ──
    const positionsChannel = supabase
      .channel('trade-history-positions')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'positions', filter: `user_id=eq.${userId}` },
        () => {
          supabase
            .from('trades')
            .select('*')
            .eq('client_id', userId)
            .neq('status', 'open')
            .order('created_at', { ascending: false })
            .then(({ data }) => {
              if (!mounted) return;
              setTrades((data as Trade[]) ?? []);
            });
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
      supabase.removeChannel(positionsChannel);
    };
  }, [userId]);

  const handleCleanGhostData = async () => {
    setCleaning(true);
    setCleanResult(null);
    const { data, error } = await supabase
      .from('trades')
      .update({ status: 'cancelled' })
      .eq('client_id', userId)
      .eq('status', 'open');
    if (error) {
      setCleanResult('Failed to clean ghost data.');
    } else {
      const count = (data as unknown as { count: number } | null)?.count ?? 0;
      setCleanResult(count > 0 ? `Cleaned ${count} orphaned open trade(s).` : 'No ghost data found.');
      setTrades(prev => prev.filter(t => t.status !== 'open'));
    }
    setCleaning(false);
    setTimeout(() => setCleanResult(null), 5000);
  };

  if (loading) {
    return (
      <div className="space-y-5 animate-slide-up">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="h-6 w-40 rounded bg-slate-800 animate-pulse mb-2" />
            <div className="h-4 w-64 rounded bg-slate-800/70 animate-pulse" />
          </div>
        </div>
        <SkeletonTable rows={6} />
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-slide-up">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <History className="w-5 h-5 text-neon-cyan" />
            Trade History
          </h2>
          <p className="text-sm text-slate-400">Complete log of all your closed and executed trades</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleCleanGhostData}
            disabled={cleaning}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-neon-amber/10 border border-neon-amber/30 text-neon-amber text-xs font-bold hover:bg-neon-amber/20 transition-all disabled:opacity-50"
          >
            {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {cleaning ? 'Cleaning...' : 'Clean Ghost Data'}
          </button>
          {cleanResult && (
            <span className="flex items-center gap-1.5 text-[10px] text-neon-green font-semibold">
              <CheckCircle2 className="w-3 h-3" /> {cleanResult}
            </span>
          )}
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="glass-card p-12 flex flex-col items-center justify-center text-center">
          <History className="w-12 h-12 text-slate-600 mb-3" />
          <p className="text-sm font-semibold text-slate-300">No trades yet</p>
          <p className="text-xs text-slate-500 mt-1">Your executed trades will appear here once your bots start trading.</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="text-left py-3 px-4 font-semibold">Time</th>
                  <th className="text-left py-3 px-4 font-semibold">Asset</th>
                  <th className="text-center py-3 px-4 font-semibold">Side</th>
                  <th className="text-center py-3 px-4 font-semibold hidden sm:table-cell">Market</th>
                  <th className="text-right py-3 px-4 font-semibold">Entry Price</th>
                  <th className="text-right py-3 px-4 font-semibold hidden sm:table-cell">Qty</th>
                  <th className="text-center py-3 px-4 font-semibold hidden md:table-cell">Lev</th>
                  <th className="text-center py-3 px-4 font-semibold">Status</th>
                  <th className="text-right py-3 px-4 font-semibold">Live PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 px-4 text-xs text-slate-500 font-mono">
                      {new Date(t.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="py-3 px-4 font-semibold text-white">{t.coin}</td>
                    <td className="py-3 px-4 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold ${t.direction === 'long' ? 'text-neon-green bg-neon-green/10' : 'text-neon-red bg-neon-red/10'}`}>
                        {t.direction === 'long' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center text-xs text-slate-400 hidden sm:table-cell capitalize">{t.market_type}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">{formatInr(Number(t.entry_price))}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300 hidden sm:table-cell">{Number(t.quantity).toFixed(4)}</td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums text-slate-400 hidden md:table-cell">{t.leverage}x</td>
                    <td className="py-3 px-4 text-center">
                      <span className={`text-[10px] font-bold capitalize ${t.status === 'closed_tp' ? 'text-neon-green' : t.status === 'closed_sl' ? 'text-neon-red' : 'text-slate-500'}`}>
                        {t.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-600">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
