import { useEffect, useState } from 'react';
import { Activity, Play, Pause, Square, TrendingUp, Zap, Loader2, Bot as BotIcon, AlertOctagon, Crosshair, ArrowUp, ArrowDown, Radio, XCircle, CheckSquare, Square as UncheckSquare, AlertTriangle, LogOut, Trash2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { supabase, type Bot, type RiskSettings, type Trade } from '@/lib/supabase';
import { usePositionMonitor } from '@/hooks/usePositionMonitor';
import { useUnrealizedPnl } from '@/hooks/useUnrealizedPnl';
import { SkeletonCard, SkeletonStat } from '@/components/Skeleton';

const statusConfig = {
  running: { color: 'text-neon-green', bg: 'bg-neon-green/10', border: 'border-neon-green/30', label: 'RUNNING' },
  paused: { color: 'text-neon-amber', bg: 'bg-neon-amber/10', border: 'border-neon-amber/30', label: 'PAUSED' },
  idle: { color: 'text-slate-500', bg: 'bg-white/[0.03]', border: 'border-white/[0.06]', label: 'IDLE' },
  paper: { color: 'text-neon-cyan', bg: 'bg-neon-cyan/10', border: 'border-neon-cyan/30', label: 'PAPER' },
  inactive: { color: 'text-slate-600', bg: 'bg-white/[0.02]', border: 'border-white/[0.04]', label: 'CLOSED' },
};

export default function TradingStatusView() {
  const { formatInr } = useApp();
  const { session, effectiveUserId, impersonating, stopImpersonation } = useAuth();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [killSwitch, setKillSwitch] = useState(false);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const { positions, lastUpdate } = usePositionMonitor();
  const [closingBotId, setClosingBotId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActioning, setBulkActioning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [squaringOffId, setSquaringOffId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);
  const [tradeNowId, setTradeNowId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = effectiveUserId ?? '';

    Promise.all([
      supabase.from('bots').select('*').eq('user_id', userId).neq('status', 'inactive').order('created_at', { ascending: false }),
      supabase.from('risk_settings').select('*').limit(1).maybeSingle(),
      supabase.from('trades').select('*').eq('client_id', userId).order('created_at', { ascending: false }),
      supabase.from('positions').select('close_pnl').eq('user_id', userId).neq('status', 'open'),
    ]).then(([botsRes, riskRes, tradesRes, closedPosRes]) => {
      if (!mounted) return;
      setBots((botsRes.data as Bot[]) ?? []);
      setKillSwitch((riskRes.data as RiskSettings | null)?.global_kill_switch ?? false);
      const allTrades = (tradesRes.data as Trade[]) ?? [];
      setOpenTrades(allTrades.filter(t => t.status === 'open'));
      const closedPositions = (closedPosRes.data as { close_pnl: number | null }[]) ?? [];
      const realized = closedPositions.reduce((sum, p) => sum + Number(p.close_pnl ?? 0), 0);
      setRealizedPnl(realized);
      setLoading(false);
    });

    const channel = supabase
      .channel('trading-status-trades')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trades', filter: `client_id=eq.${userId}` },
        (payload) => {
          const newTrade = payload.new as Trade;
          if (newTrade.status === 'open') {
            setOpenTrades(prev => [newTrade, ...prev]);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trades', filter: `client_id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as Trade;
          setOpenTrades(prev => {
            if (updated.status === 'open') {
              return prev.map(t => t.id === updated.id ? updated : t);
            }
            return prev.filter(t => t.id !== updated.id);
          });
        },
      )
      .subscribe();

    const botsChannel = supabase
      .channel('trading-status-bots')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bots', filter: `user_id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as Bot;
          setBots(prev => {
            if (updated.status === 'inactive') {
              setSelectedIds(prevSel => {
                const next = new Set(prevSel);
                next.delete(updated.id);
                return next;
              });
              return prev.filter(b => b.id !== updated.id);
            }
            return prev.map(b => b.id === updated.id ? updated : b);
          });
        },
      )
      .subscribe();

    const positionsChannel = supabase
      .channel('trading-status-positions')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'positions', filter: `user_id=eq.${userId}` },
        () => {
          Promise.all([
            supabase.from('trades').select('*').eq('client_id', userId).order('created_at', { ascending: false }),
            supabase.from('positions').select('close_pnl').eq('user_id', userId).neq('status', 'open'),
          ]).then(([tradesRes, closedPosRes]) => {
            if (!mounted) return;
            const allTrades = (tradesRes.data as Trade[]) ?? [];
            setOpenTrades(allTrades.filter(t => t.status === 'open'));
            const closedPositions = (closedPosRes.data as { close_pnl: number | null }[]) ?? [];
            const realized = closedPositions.reduce((sum, p) => sum + Number(p.close_pnl ?? 0), 0);
            setRealizedPnl(realized);
          });
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
      supabase.removeChannel(positionsChannel);
      supabase.removeChannel(botsChannel);
    };
  }, [effectiveUserId]);

  const { unrealizedPnlMap, totalUnrealized } = useUnrealizedPnl(openTrades);

  const activeCount = bots.filter(b => b.status === 'running').length;
  const openPositionsCount = openTrades.length;
  const totalPnl = realizedPnl + totalUnrealized;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  // ── Square Off: call edge function, only remove from UI on strict success ──
  const handleSquareOff = async (tradeId: string, coin: string) => {
    const positionId = positions.find(p => p.symbol?.replace('USDT', '') === coin && p.status === 'open')?.id;
    setSquaringOffId(tradeId);

    if (!positionId) {
      showToast(`Square off failed: no open position found for ${coin}`);
      setSquaringOffId(null);
      return;
    }

    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/close-single-position`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession?.access_token ?? ''}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ position_id: positionId }),
      });
      const result = await resp.json();
      if (resp.ok && result.success) {
        setOpenTrades(prev => prev.filter(t => t.id !== tradeId));
        showToast(`${coin} squared off — P&L: ${formatInr(result.pnl ?? 0)}`);
      } else {
        const errMsg = result.error ?? result.detail ?? `HTTP ${resp.status}`;
        showToast(`Square off FAILED — ${errMsg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      showToast(`Square off FAILED — ${msg}`);
    } finally {
      setSquaringOffId(null);
    }
  };

  const handleTradeNow = async (botId: string, botName: string) => {
    setTradeNowId(botId);
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/execute-trade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession?.access_token ?? ''}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ botId, action: 'open' }),
      });
      const result = await resp.json();
      if (resp.ok && result.success) {
        showToast(`${botName}: Trade executed & position opened!`);
      } else {
        const rawError = result.dbInsertError ?? result.error ?? result.detail ?? (resp.ok ? 'Trade failed — no error returned' : `HTTP ${resp.status}`);
        showToast(`${botName}: FAILED — ${rawError}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      showToast(`${botName}: FAILED — ${msg}`);
    } finally {
      setTradeNowId(null);
    }
  };

  const updateStatus = async (id: string, status: Bot['status']) => {
    const prevBots = bots;
    setBots(prev => prev.map(b => b.id === id ? { ...b, status } : b));
    const { error } = await supabase.from('bots').update({ status }).eq('id', id);
    if (error) {
      setBots(prevBots);
      showToast(`Failed to update bot status: ${error.message}`);
    }
  };

  const handleCloseBot = async (botId: string) => {
    setClosingBotId(botId);
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trigger-panic-sell`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession?.access_token ?? ''}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ mode: 'user', bot_id: botId }),
      });
      const result = await resp.json();
      if (!resp.ok) {
        showToast(`Failed to close bot: ${result.error ?? 'Unknown error'}`);
      } else {
        setBots(prev => prev.filter(b => b.id !== botId));
        showToast(`Bot closed — ${result.positionsClosed ?? 0} positions liquidated`);
      }
    } catch {
      showToast('Network error while closing bot. Please try again.');
    } finally {
      setClosingBotId(null);
    }
  };

  // ── Bulk selection helpers ──
  const allSelected = bots.length > 0 && bots.every(b => selectedIds.has(b.id));
  const someSelected = bots.some(b => selectedIds.has(b.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(bots.map(b => b.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Bulk actions ──
  const handleBulkStatus = async (status: Bot['status']) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActioning(true);
    const prevBots = bots;
    setBots(prev => prev.map(b => selectedIds.has(b.id) ? { ...b, status } : b));
    const results = await Promise.allSettled(
      ids.map(id => supabase.from('bots').update({ status }).eq('id', id))
    );
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.error)).length;
    if (failed > 0) {
      setBots(prevBots);
      showToast(`${failed} bot${failed !== 1 ? 's' : ''} failed to update — reverted`);
    } else {
      showToast(`${ids.length} bot${ids.length !== 1 ? 's' : ''} ${status === 'running' ? 'started' : status === 'paused' ? 'paused' : 'stopped'}`);
      setSelectedIds(new Set());
    }
    setBulkActioning(false);
  };

  const handleBulkClose = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActioning(true);
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const results = await Promise.allSettled(
        ids.map(id =>
          fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trigger-panic-sell`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${currentSession?.access_token ?? ''}`,
              'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ mode: 'user', bot_id: id }),
          })
        )
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      showToast(`Bulk close: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}`);
      setBots(prev => prev.filter(b => !selectedIds.has(b.id)));
      setSelectedIds(new Set());
    } catch {
      showToast('Bulk close network error');
    } finally {
      setBulkActioning(false);
    }
  };

  // ── Hard Delete a single bot (and its open positions) ──
  const handleDeleteBot = async (botId: string) => {
    setDeletingBotId(botId);
    const userId = effectiveUserId ?? '';
    try {
      const bot = bots.find(b => b.id === botId);
      if (bot) {
        const symbol = `${bot.coin}USDT`;
        const { error: posErr } = await supabase.from('positions').update({
          status: 'closed_manual',
          closed_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('symbol', symbol).eq('status', 'open');
        if (posErr) {
          showToast(`Failed to close positions: ${posErr.message}`);
          setDeletingBotId(null);
          setDeleteTarget(null);
          return;
        }
        const { error: tradeErr } = await supabase.from('trades').update({ status: 'closed_manual' })
          .eq('client_id', userId).eq('coin', bot.coin).eq('status', 'open');
        if (tradeErr) {
          showToast(`Failed to close trades: ${tradeErr.message}`);
          setDeletingBotId(null);
          setDeleteTarget(null);
          return;
        }
      }
      const { error: delErr } = await supabase.from('bots').delete().eq('id', botId);
      if (delErr) {
        showToast(`Failed to delete bot: ${delErr.message}`);
        setDeletingBotId(null);
        setDeleteTarget(null);
        return;
      }
      setBots(prev => prev.filter(b => b.id !== botId));
      setOpenTrades(prev => prev.filter(t => t.coin !== bot?.coin));
      setSelectedIds(prev => { const n = new Set(prev); n.delete(botId); return n; });
      showToast(`Bot deleted permanently — plan limit freed up`);
    } catch {
      showToast('Failed to delete bot. Please try again.');
    } finally {
      setDeletingBotId(null);
      setDeleteTarget(null);
    }
  };

  // ── Bulk hard delete selected bots ──
  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActioning(true);
    const userId = effectiveUserId ?? '';
    let failedCount = 0;
    const deletedIds: string[] = [];
    try {
      for (const id of ids) {
        const bot = bots.find(b => b.id === id);
        if (bot) {
          const symbol = `${bot.coin}USDT`;
          const { error: posErr } = await supabase.from('positions').update({
            status: 'closed_manual',
            closed_at: new Date().toISOString(),
          }).eq('user_id', userId).eq('symbol', symbol).eq('status', 'open');
          if (posErr) console.error('Bulk delete: failed to close positions:', posErr.message);
          const { error: tradeErr } = await supabase.from('trades').update({ status: 'closed_manual' })
            .eq('client_id', userId).eq('coin', bot.coin).eq('status', 'open');
          if (tradeErr) console.error('Bulk delete: failed to close trades:', tradeErr.message);
        }
        const { error: delErr } = await supabase.from('bots').delete().eq('id', id);
        if (delErr) {
          failedCount++;
        } else {
          deletedIds.push(id);
        }
      }
      if (deletedIds.length > 0) {
        const deletedSet = new Set(deletedIds);
        setBots(prev => prev.filter(b => !deletedSet.has(b.id)));
        setOpenTrades(prev => prev.filter(t => !deletedIds.some(id => t.coin === bots.find(b => b.id === id)?.coin)));
        setSelectedIds(new Set());
      }
      if (failedCount > 0) {
        showToast(`${deletedIds.length} deleted, ${failedCount} failed — check permissions`);
      } else {
        showToast(`${deletedIds.length} bot${deletedIds.length !== 1 ? 's' : ''} deleted permanently`);
      }
    } catch {
      showToast('Some bots could not be deleted.');
    } finally {
      setBulkActioning(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5 animate-slide-up">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <SkeletonStat key={i} />)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-slide-up">
      {/* Admin impersonation indicator — only visible to the admin, not to the real user */}
      {impersonating && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-neon-amber/10 border border-neon-amber/30 animate-slide-up">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-neon-amber/15 border border-neon-amber/30 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-4 h-4 text-neon-amber" />
            </div>
            <div>
              <p className="text-sm font-bold text-neon-amber">Viewing as {impersonating.email}</p>
              <p className="text-xs text-slate-400">Admin oversight mode — all actions are logged to admin_activity_log</p>
            </div>
          </div>
          <button onClick={stopImpersonation} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/[0.06] text-slate-200 border border-white/[0.1] hover:bg-white/[0.1] transition-all">
            <LogOut className="w-3.5 h-3.5" /> Exit
          </button>
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Activity className="w-5 h-5 text-neon-cyan" />
          Trading Status
        </h2>
        <p className="text-sm text-slate-400">Monitor all active and idle trading bots in real-time</p>
      </div>

      {/* Kill Switch Banner */}
      {killSwitch && (
        <div className="rounded-2xl bg-neon-red/10 border border-neon-red/30 p-4 flex items-center gap-3 animate-slide-up">
          <div className="w-10 h-10 rounded-xl bg-neon-red/15 border border-neon-red/30 flex items-center justify-center flex-shrink-0">
            <AlertOctagon className="w-5 h-5 text-neon-red" />
          </div>
          <div>
            <p className="text-sm font-bold text-neon-red">Platform Execution Paused by Master Admin</p>
            <p className="text-xs text-slate-400 mt-0.5">All bot start and launch operations are temporarily disabled. You can still pause or stop existing bots.</p>
          </div>
        </div>
      )}

      {/* Cloud Engine Status Bar */}
      {openPositionsCount > 0 && (
        <div className="glass-card p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-neon-green" />
            <span className="text-xs text-slate-400">
              Cloud engine monitoring {openPositionsCount} open position{openPositionsCount > 1 ? 's' : ''} autonomously (cron every 1 min)
            </span>
          </div>
          {lastUpdate && (
            <span className="text-[10px] text-slate-500">
              Updated {lastUpdate.toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat label="Active Bots" value={`${activeCount}/${bots.length}`} icon={Zap} color="text-neon-green" />
        <MiniStat label="Total P&L" value={`${totalPnl > 0 ? '+' : ''}${formatInr(totalPnl)}`} icon={TrendingUp} color={totalPnl > 0 ? 'text-neon-green' : totalPnl < 0 ? 'text-neon-red' : 'text-slate-400'} />
        <MiniStat label="Open Positions" value={openPositionsCount.toString()} icon={Crosshair} color="text-neon-cyan" />
        <MiniStat label="Unrealized P&L" value={`${totalUnrealized > 0 ? '+' : ''}${formatInr(totalUnrealized)}`} icon={totalUnrealized >= 0 ? ArrowUp : ArrowDown} color={totalUnrealized > 0 ? 'text-neon-green' : totalUnrealized < 0 ? 'text-neon-red' : 'text-slate-400'} />
      </div>

      {/* Open Positions Panel */}
      {openPositionsCount > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-neon-cyan" />
            Live Open Positions
            <span className="text-[10px] text-slate-500 font-normal">(cloud cron · 1 min interval)</span>
          </h3>
          <div className="space-y-2">
            {openTrades.map((trade) => {
              const isLong = trade.direction === 'long';
              const pnl = unrealizedPnlMap.get(trade.id) ?? 0;
              const pnlPositive = pnl >= 0;
              return (
                <div key={trade.id} className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold ${isLong ? 'bg-neon-green/10 text-neon-green border border-neon-green/20' : 'bg-neon-red/10 text-neon-red border border-neon-red/20'}`}>
                      {isLong ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white">{trade.coin}/USDT</p>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        {trade.executed_by} · {trade.leverage}x · Entry: ${Number(trade.entry_price).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className={`text-sm font-mono tabular-nums font-bold ${pnl > 0 ? 'text-neon-green' : pnl < 0 ? 'text-neon-red' : 'text-slate-400'}`}>
                        {pnl > 0 ? '+' : ''}{formatInr(pnl)}
                      </p>
                      <p className="text-[10px] text-slate-500">Qty: {Number(trade.quantity).toFixed(4)}</p>
                    </div>
                    <button
                      onClick={() => handleSquareOff(trade.id, trade.coin)}
                      disabled={squaringOffId === trade.id}
                      title="Manually exit this position now"
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-neon-red/15 text-neon-red border border-neon-red/40 hover:bg-neon-red/25 transition-all disabled:opacity-40 whitespace-nowrap"
                    >
                      {squaringOffId === trade.id ? (
                        <><Loader2 className="w-3 h-3 animate-spin" /></>
                      ) : (
                        <><XCircle className="w-3 h-3" /> Square Off</>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bot cards with bulk selection */}
      {bots.length === 0 ? (
        <div className="glass-card p-12 flex flex-col items-center justify-center text-center">
          <BotIcon className="w-12 h-12 text-slate-600 mb-3" />
          <p className="text-sm font-semibold text-slate-300">No bots deployed yet</p>
          <p className="text-xs text-slate-500 mt-1">Head to the AI Smart Bot builder to create your first trading bot.</p>
        </div>
      ) : (
        <>
          {/* Bulk Action Bar */}
          {selectedIds.size > 0 && (
            <div className="sticky top-0 z-20 flex items-center justify-between gap-3 px-4 py-3 rounded-xl glass-card border border-neon-amber/20 animate-slide-up">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-neon-amber/15 border border-neon-amber/30 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-4 h-4 text-neon-amber" />
                </div>
                <span className="text-sm font-semibold text-white">
                  {selectedIds.size} bot{selectedIds.size !== 1 ? 's' : ''} selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setSelectedIds(new Set())} disabled={bulkActioning}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all disabled:opacity-40">
                  Clear
                </button>
                <button onClick={() => handleBulkStatus('running')} disabled={bulkActioning || killSwitch}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-neon-green/15 text-neon-green border border-neon-green/30 hover:bg-neon-green/25 transition-all disabled:opacity-40 active:scale-[0.98]">
                  <Play className="w-3.5 h-3.5" /> Start
                </button>
                <button onClick={() => handleBulkStatus('paused')} disabled={bulkActioning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-neon-amber/15 text-neon-amber border border-neon-amber/30 hover:bg-neon-amber/25 transition-all disabled:opacity-40 active:scale-[0.98]">
                  <Pause className="w-3.5 h-3.5" /> Pause
                </button>
                <button onClick={() => handleBulkStatus('idle')} disabled={bulkActioning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white/[0.06] text-slate-300 border border-white/[0.1] hover:bg-white/[0.1] transition-all disabled:opacity-40 active:scale-[0.98]">
                  <Square className="w-3.5 h-3.5" /> Stop
                </button>
                <button onClick={handleBulkClose} disabled={bulkActioning}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-neon-red/80 border border-neon-red hover:bg-neon-red transition-all disabled:opacity-50 active:scale-[0.98]">
                  {bulkActioning ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Closing...</> : <><XCircle className="w-3.5 h-3.5" /> Close</>}
                </button>
                <button onClick={handleBulkDelete} disabled={bulkActioning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-neon-red/15 text-neon-red border border-neon-red/40 hover:bg-neon-red/25 transition-all disabled:opacity-50 active:scale-[0.98]">
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              </div>
            </div>
          )}

          {/* Select All header */}
          <div className="flex items-center gap-3 px-1">
            <button onClick={toggleSelectAll} disabled={bulkActioning}
              title={allSelected ? 'Deselect all' : 'Select all'}
              className="text-slate-400 hover:text-neon-amber transition-colors disabled:opacity-40">
              {allSelected ? <CheckSquare className="w-5 h-5 text-neon-amber" /> : someSelected ? <CheckSquare className="w-5 h-5 text-neon-amber/50" /> : <UncheckSquare className="w-5 h-5" />}
            </button>
            <span className="text-xs text-slate-500">
              {allSelected ? 'All selected' : someSelected ? `${selectedIds.size} selected` : 'Select all bots'}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bots.map((bot) => {
              const sc = statusConfig[bot.status] ?? statusConfig.idle;
              const isSelected = selectedIds.has(bot.id);
              const botOpenTrades = openTrades.filter(t => t.coin === bot.coin);
              const botUnrealized = botOpenTrades.reduce((sum, t) => sum + (unrealizedPnlMap.get(t.id) ?? 0), 0);
              const botRealized = Number(bot.profit_loss) ?? 0;
              const botTotalPnl = botRealized + botUnrealized;
              const individualDisabled = bulkActioning || selectedIds.size > 0;
              return (
                <div key={bot.id} className={`glass-card p-5 relative overflow-hidden transition-all ${bot.status === 'running' ? sc.border : ''} ${isSelected ? 'ring-1 ring-neon-amber/40' : ''}`}>
                  {bot.status === 'running' && <div className="absolute -top-10 -right-10 w-28 h-28 bg-neon-green/5 rounded-full blur-3xl" />}
                  <div className="relative">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        {/* Checkbox */}
                        <button onClick={() => toggleSelectOne(bot.id)} disabled={bulkActioning}
                          title={isSelected ? 'Deselect' : 'Select'}
                          className="text-slate-400 hover:text-neon-amber transition-colors disabled:opacity-40 flex-shrink-0">
                          {isSelected ? <CheckSquare className="w-5 h-5 text-neon-amber" /> : <UncheckSquare className="w-5 h-5" />}
                        </button>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-white">{bot.name}</h3>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{bot.coin}/USDT · {bot.market_type.toUpperCase()}</p>
                        </div>
                      </div>
                      <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold ${sc.bg} ${sc.color} ${sc.border} border flex items-center gap-1.5`}>
                        {bot.status === 'running' && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neon-green opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-neon-green" />
                          </span>
                        )}
                        {sc.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-4 gap-3 mb-4">
                      <BotStat label="Strategy" value={bot.strategy.charAt(0).toUpperCase() + bot.strategy.slice(1)} />
                      <BotStat label="P&L" value={`${botTotalPnl > 0 ? '+' : ''}${formatInr(botTotalPnl)}`} accent={botTotalPnl > 0 ? 'text-neon-green' : botTotalPnl < 0 ? 'text-neon-red' : 'text-slate-400'} />
                      <BotStat label="Market" value={bot.market_type.toUpperCase()} />
                      <BotStat label="Coin" value={bot.coin} />
                    </div>

                    {/* Controls */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateStatus(bot.id, 'running')}
                        disabled={individualDisabled || killSwitch || bot.status === 'running'}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                          bot.status === 'running'
                            ? 'glass text-slate-400 cursor-default'
                            : killSwitch
                            ? 'bg-white/[0.02] text-slate-600 border border-white/[0.04] cursor-not-allowed'
                            : 'bg-neon-green/10 text-neon-green border border-neon-green/30 hover:neon-glow-green'
                        }`}
                      >
                        <Play className="w-3.5 h-3.5" /> Start
                      </button>
                      <button
                        onClick={() => handleTradeNow(bot.id, bot.name)}
                        disabled={individualDisabled || killSwitch || tradeNowId === bot.id || bot.status !== 'running'}
                        title="Execute an instant trade on this bot right now"
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/20 transition-all"
                      >
                        {tradeNowId === bot.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <><Zap className="w-3.5 h-3.5" /> Trade Now</>
                        )}
                      </button>
                      <button
                        onClick={() => updateStatus(bot.id, 'paused')}
                        disabled={individualDisabled}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${bot.status === 'paused' ? 'glass text-slate-400 cursor-default' : 'bg-neon-amber/10 text-neon-amber border border-neon-amber/30 hover:bg-neon-amber/20'}`}
                      >
                        <Pause className="w-3.5 h-3.5" /> Pause
                      </button>
                      <button
                        onClick={() => updateStatus(bot.id, 'idle')}
                        disabled={individualDisabled}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neon-red/10 text-neon-red border border-neon-red/30 hover:bg-neon-red/20 transition-all"
                      >
                        <Square className="w-3.5 h-3.5" /> Stop
                      </button>
                      <button
                        onClick={() => handleCloseBot(bot.id)}
                        disabled={individualDisabled || closingBotId === bot.id}
                        title="Close all positions for this bot and stop it"
                        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neon-red/20 text-neon-red border border-neon-red/50 hover:bg-neon-red/30 transition-all"
                      >
                        {closingBotId === bot.id ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Closing...</>
                        ) : (
                          <><XCircle className="w-3.5 h-3.5" /> Close</>
                        )}
                      </button>
                      <button
                        onClick={() => setDeleteTarget(bot)}
                        disabled={individualDisabled || deletingBotId === bot.id}
                        title="Permanently delete this bot and free up your plan limit"
                        className="flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold bg-neon-red/10 text-neon-red border border-neon-red/30 hover:bg-neon-red/20 transition-all"
                      >
                        {deletingBotId === bot.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in">
          <div className="absolute inset-0 bg-base-900/80 backdrop-blur-md" onClick={() => setDeleteTarget(null)} />
          <div className="relative w-full max-w-md animate-scale-in">
            <div className="glass-strong neon-glow-red p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-neon-red" />
                <h2 className="text-base font-bold text-white">Delete Bot?</h2>
              </div>
              <p className="text-sm text-slate-300 mb-2">
                This will permanently delete <span className="font-bold text-white">{deleteTarget.name}</span> and close any open positions for {deleteTarget.coin}/USDT.
              </p>
              <p className="text-xs text-slate-400 mb-5">
                This frees up your bot plan limit so you can create a new bot. This action cannot be undone.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 px-4 py-2.5 rounded-xl glass hover:bg-white/[0.07] text-sm text-slate-300 transition-all">
                  Cancel
                </button>
                <button onClick={() => handleDeleteBot(deleteTarget.id)} disabled={deletingBotId === deleteTarget.id}
                  className="flex-1 px-4 py-2.5 rounded-xl border font-semibold text-sm transition-all active:scale-95 bg-neon-red/20 border-neon-red/40 text-neon-red hover:bg-neon-red/30 disabled:opacity-50">
                  {deletingBotId === deleteTarget.id ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Delete Permanently'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl glass-card border border-white/[0.1] text-xs text-white font-medium shadow-xl animate-slide-up whitespace-nowrap z-[100]">
          {toast}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, icon: Icon, color }: { label: string; value: string; icon: typeof Activity; color: string }) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className={`text-lg font-bold font-mono tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function BotStat({ label, value, accent = 'text-slate-200' }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-[9px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-xs font-bold font-mono tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}
