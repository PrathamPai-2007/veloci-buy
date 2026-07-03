import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('CSS media queries for viewports under 640px hide desktop nav, show mobile controls, and stack Trade History', () => {
  const cssPath = path.resolve(process.cwd(), 'website/src/index.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Verify mobile responsive block for navigation exists
  assert.ok(
    cssContent.includes('@media (max-width: 639px)'),
    'Should contain media query for under 640px (e.g. max-width: 639px)'
  );

  // Verify that the media query correctly alters display states of desktop nav and mobile elements
  const desktopNavRule = /\.desktop-nav\s*\{\s*display:\s*none\s*!important;\s*\}/;
  const mobileNavToggleRule = /\.mobile-nav-toggle\s*\{\s*display:\s*flex\s*!important;\s*\}/;
  const mobileMenuRule = /\.mobile-menu\s*\{[^}]*display:\s*flex\s*!important;[^}]*\}/;
  const tradeTableInnerRule = /\.trade-table-inner\s*\{\s*min-width:\s*0\s*!important;\s*\}/;
  const tradeTableHeaderRule = /\.trade-table-header\s*\{\s*display:\s*none\s*!important;\s*\}/;
  const tradeRowRule =
    /\.trade-row\s*\{[^}]*display:\s*flex\s*!important;[^}]*flex-direction:\s*column\s*!important;[^}]*\}/;
  const tradeCellRule =
    /\.trade-cell\s*\{[^}]*display:\s*flex\s*!important;[^}]*justify-content:\s*space-between\s*!important;[^}]*\}/;
  const tradeCellBeforeRule = /\.trade-cell::before\s*\{\s*content:\s*attr\(data-label\);/;

  assert.match(cssContent, desktopNavRule, 'Should hide desktop nav');
  assert.match(cssContent, mobileNavToggleRule, 'Should show mobile nav toggle');
  assert.match(cssContent, mobileMenuRule, 'Should show mobile menu');
  assert.match(cssContent, tradeTableInnerRule, 'Should reset trade table inner min-width');
  assert.match(cssContent, tradeTableHeaderRule, 'Should hide trade table headers');
  assert.match(cssContent, tradeRowRule, 'Should display trade row as vertical flex container');
  assert.match(cssContent, tradeCellRule, 'Should display trade cells as space-between flex row');
  assert.match(cssContent, tradeCellBeforeRule, 'Should display labels from data-label attribute');
});

test('Theme toggle behavior in App.tsx reads from localStorage, toggles theme, writes to localStorage, and updates documentElement classList', () => {
  const appPath = path.resolve(process.cwd(), 'website/src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify reading theme from localStorage
  const checkLocalStorageGet = /localStorage\.getItem\(['"]theme['"]\)/;
  assert.match(appContent, checkLocalStorageGet, 'App.tsx must read theme from localStorage');

  // Verify writing theme to localStorage on toggle
  const checkLocalStorageSet = /localStorage\.setItem\(['"]theme['"],\s*next\)/;
  assert.match(
    appContent,
    checkLocalStorageSet,
    'App.tsx must write theme to localStorage on toggle'
  );

  // Verify applying class 'dark' to document.documentElement
  const checkClassAdd = /document\.documentElement\.classList\.add\(['"]dark['"]\)/;
  const checkClassRemove = /document\.documentElement\.classList\.remove\(['"]dark['"]\)/;
  assert.match(
    appContent,
    checkClassAdd,
    "App.tsx must add 'dark' class to document.documentElement"
  );
  assert.match(
    appContent,
    checkClassRemove,
    "App.tsx must remove 'dark' class from document.documentElement"
  );
});

test('Dashboard.tsx propagates theme and correctly uses data-label values', () => {
  const dashboardPath = path.resolve(process.cwd(), 'website/src/Dashboard.tsx');
  const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');

  // Verify prop types or interface for theme toggling exists
  assert.match(
    dashboardContent,
    /onToggleTheme:\s*\(\)\s*=>\s*void/,
    'Dashboard must define onToggleTheme prop'
  );

  // Verify Dashboard propagates Click handler
  assert.match(
    dashboardContent,
    /onClick=\{onToggleTheme\}/,
    'Dashboard theme toggles must use the onToggleTheme callback'
  );

  // Verify Trade row renders the trade-cell class with data-label
  assert.match(
    dashboardContent,
    /data-label="STATUS"/,
    'Trade rows must render STATUS cell with data-label'
  );
  assert.match(
    dashboardContent,
    /data-label="TOKEN"/,
    'Trade rows must render TOKEN cell with data-label'
  );
  assert.match(
    dashboardContent,
    /data-label="PLATFORM"/,
    'Trade rows must render PLATFORM cell with data-label'
  );
  assert.match(
    dashboardContent,
    /data-label="DETAILS"/,
    'Trade rows must render DETAILS cell with data-label'
  );
});
