import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('App.tsx and Dashboard.tsx support toaster visibility across routing boundaries', () => {
  const appPath = path.resolve(process.cwd(), 'website/src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  const dashboardPath = path.resolve(process.cwd(), 'website/src/Dashboard.tsx');
  const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');

  // Verify App.tsx imports Toaster from sonner
  assert.ok(
    appContent.includes("import { Toaster } from 'sonner';") ||
      appContent.includes('import { Toaster } from "sonner";'),
    'App.tsx should import Toaster from sonner'
  );

  // Verify Toaster is mounted at the root level of App.tsx
  const toasterRegex = /<\s*Toaster\s+[^>]*\/>/;
  assert.match(appContent, toasterRegex, 'App.tsx must render Toaster at the root return block');

  // Verify Dashboard.tsx imports toast from sonner
  assert.ok(
    dashboardContent.includes("import { toast } from 'sonner';") ||
      dashboardContent.includes('import { toast } from "sonner";'),
    'Dashboard.tsx should import toast from sonner'
  );

  // Verify toast triggers on connection state transitions
  const wsConnectedToastSuccessRegex = /toast\.success\(['"]Engine Connected['"]\)/;
  const wsConnectedToastErrorRegex = /toast\.error\(['"]Engine Disconnected['"]\)/;
  assert.match(
    dashboardContent,
    wsConnectedToastSuccessRegex,
    'Dashboard must toast success on engine connection'
  );
  assert.match(
    dashboardContent,
    wsConnectedToastErrorRegex,
    'Dashboard must toast error on engine disconnection'
  );

  // Verify toast triggers on trading mode transitions (live/paper)
  const modeToastInfoRegex = /toast\.info\(['"]Switched to Paper Trading['"]\)/;
  const modeToastSuccessRegex = /toast\.success\(['"]Switched to Live Trading['"]\)/;
  assert.match(
    dashboardContent,
    modeToastInfoRegex,
    'Dashboard must toast info when switching to paper trading'
  );
  assert.match(
    dashboardContent,
    modeToastSuccessRegex,
    'Dashboard must toast success when switching to live trading'
  );
});

test('Dashboard.tsx statistical and table skeleton transitions bypass when wsConnected is true', () => {
  const dashboardPath = path.resolve(process.cwd(), 'website/src/Dashboard.tsx');
  const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');

  // Statistical Cards Skeleton Transition check:
  // Must render SkeletonCard when !wsConnected, and render stats cards when wsConnected is true
  const wsConnectedStatsCondition = /!\s*wsConnected\s*\?\s*\(\s*<>\s*<SkeletonCard \/>/;
  assert.match(
    dashboardContent,
    wsConnectedStatsCondition,
    'Dashboard should render SkeletonCards only when !wsConnected'
  );

  // Table Row Skeletons check (overview tab):
  // Must render SkeletonRows when !wsConnected. If wsConnected is true:
  // If trade history is empty (liveData.recentTrades.length === 0), render empty state message.
  // If not empty, render rows.
  const wsConnectedRowCondition =
    /!\s*wsConnected\s*\?\s*\(\s*<>\s*\{\s*\[\s*0,\s*1,\s*2,\s*3,\s*4\s*\]\.map/;
  const emptyHistoryCondition = /liveData\.recentTrades\.length\s*===\s*0/;
  const emptyHistoryText = /No recent executions found in state\./;

  assert.match(
    dashboardContent,
    wsConnectedRowCondition,
    'Dashboard should render SkeletonRows only when !wsConnected'
  );
  assert.match(
    dashboardContent,
    emptyHistoryCondition,
    'Dashboard should check if recentTrades length is 0 when wsConnected is true'
  );
  assert.match(
    dashboardContent,
    emptyHistoryText,
    'Dashboard should render empty state text when trade history is empty'
  );

  // Table Row Skeletons check (trades tab):
  // Similar to overview tab, but checks filteredTrades.length === 0
  const filteredTradesEmptyCondition = /filteredTrades\.length\s*===\s*0/;
  const filteredTradesEmptyText = /No trades match this filter\./;

  assert.match(
    dashboardContent,
    filteredTradesEmptyCondition,
    'Dashboard should check if filteredTrades length is 0 in Trades tab'
  );
  assert.match(
    dashboardContent,
    filteredTradesEmptyText,
    'Dashboard should render match-filter empty state text in Trades tab'
  );
});

test('Dashboard.tsx GSAP Profit/Loss pulse cleans up its injected div and GSAP context on unmount', () => {
  const dashboardPath = path.resolve(process.cwd(), 'website/src/Dashboard.tsx');
  const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');

  // Verify elements of the P&L pulse useEffect:
  // 1. Appends pulseDiv to document.body
  assert.ok(
    dashboardContent.includes('document.body.appendChild(pulseDiv)'),
    'useEffect should append pulseDiv to document.body'
  );

  // 2. Creates GSAP context via gsap.context
  assert.ok(dashboardContent.includes('gsap.context'), 'useEffect should create a gsap context');

  // 3. Returns a cleanup function that reverts GSAP context and removes the pulseDiv
  const cleanupRevertRegex = /ctx\.revert\(\)/;
  const cleanupRemoveChildRegex = /document\.body\.removeChild\(pulseDiv\)/;

  assert.match(
    dashboardContent,
    cleanupRevertRegex,
    'cleanup function must revert the GSAP context'
  );
  assert.match(
    dashboardContent,
    cleanupRemoveChildRegex,
    'cleanup function must remove pulseDiv from document.body'
  );
});
